/* End-to-end regression run.
 *
 * Drives the real, built extension in Chromium — the bugs this project keeps
 * hitting live in the seams between worlds (page hook, isolated world, the
 * background, the standalone window), and mocks hide exactly those.
 *
 *   ./build.sh                      # produces build/chrome
 *   npm i -D playwright && npx playwright install chromium
 *   node test/e2e.js
 *
 * The fixtures are generated WAVs served straight out of this process through
 * Playwright routing: no temp files, and no listening socket to collide with.
 */
const { chromium } = require('playwright');
const path = require('path'), os = require('os'), fs = require('fs');

const EXT  = path.join(__dirname, '..', 'build', 'chrome');
const BASE = 'https://wf.test/t.html';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  <' + JSON.stringify(extra) + '>' : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- fixtures ---- */
const SR_HZ = 44100;
function wav(segments) {
  const s = [].concat(...segments);
  const data = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR_HZ, 24); h.writeUInt32LE(SR_HZ * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const sil   = (n) => new Array(Math.round(n * SR_HZ)).fill(0);
const tone  = (n, f = 440, a = 0.6) => Array.from({ length: Math.round(n * SR_HZ) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR_HZ));
const noise = (n, a = 0.02) => Array.from({ length: Math.round(n * SR_HZ) }, () => a * (Math.random() * 2 - 1));

const FILES = {
  // the DESIGN §9 sample: 1.2s silence + 2s tone + 1.5s faint noise = 4.70s
  'ref.mp3':   wav([sil(1.2), tone(2.0), noise(1.5)]),
  'mine.mp3':  wav([sil(0.4), tone(1.6, 330, 0.4), sil(1.0)]),
  'short.mp3': wav([tone(0.70, 660, 0.5)]),   // passes at 0.5s, filtered at 1s
  'blip.mp3':  wav([tone(0.30, 880, 0.5)]),   // always filtered
  // Six ordinary clips for the "no cap, it just scrolls" run. They must differ in
  // shape and length, not just pitch: the de-dupe fingerprint is a 32-bucket
  // loudness envelope plus the duration, and identical envelopes merge (§7).
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(i =>
    ['c' + i + '.mp3', wav([sil(0.1 * i), tone(0.8 + 0.21 * i, 200 + i * 90, 0.25 + 0.1 * i),
                            sil(0.15), tone(0.3, 300 + i * 40, 0.5 - 0.05 * i)])])),
  't.html': Buffer.from(`<!doctype html><meta charset="utf-8"><title>web audio only</title>
<h3>no &lt;audio&gt; element on this page</h3>
<script>
window.playSet = async (list) => {
  const ctx = new AudioContext();
  for (const f of list) {
    const a = await ctx.decodeAudioData(await (await fetch(f)).arrayBuffer());
    const s = ctx.createBufferSource(); s.buffer = a;
  }
};
</script>`)
};

/* The whole UI lives in a shadow root, so every probe goes through this. */
const SR = `(() => { const h = document.getElementById('__wf_viewer_host'); return h && h.shadowRoot; })()`;

(async () => {
  if (!fs.existsSync(EXT)) { console.error('build/chrome is missing — run ./build.sh first'); process.exit(2); }
  const ver = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    // Extensions need the full browser, not the headless shell, and Playwright
    // disables extensions by default.
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
           '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check']
  });
  await ctx.route('https://wf.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\//, '') || 't.html';
    const body = FILES[name];
    if (!body) return route.fulfill({ status: 404, body: 'no' });
    route.fulfill({ status: 200, body,
      contentType: name.endsWith('.html') ? 'text/html' : 'audio/mpeg',
      headers: { 'access-control-allow-origin': '*' } });
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await sleep(600);
  // No panel exists until the first lane does, so start with audio.
  await page.evaluate(`window.playSet(['ref.mp3','mine.mp3','blip.mp3','short.mp3'])`);
  await sleep(2800);

  const shown = await page.evaluate(`${SR} && ${SR}.querySelector('.ver') ? ${SR}.querySelector('.ver').textContent.trim() : null`);
  ok('panel injected, and it shows its version', shown === 'v' + ver, { shown, ver });

  const laneCss = await page.evaluate(`(() => { const s = getComputedStyle(${SR}.querySelector('.lanes'));
      return { of: s.overflowY, mh: s.maxHeight }; })()`);
  ok('lane area scrolls', laneCss.of === 'auto', laneCss);
  ok('lane area has a pixel height, so the panel can be resized', /px$/.test(laneCss.mh) && parseFloat(laneCss.mh) > 100, laneCss);

  const names = () => page.evaluate(`[...${SR}.querySelectorAll('.lane .name')].map(n => n.textContent)`);
  let ns = await names();
  ok('the 4.70s and 3.0s clips got lanes', ns.length === 2, ns);
  ok('0.30s blip filtered out', !ns.some(x => /blip/.test(x)), ns);
  ok('0.70s clip filtered out at the 1s default', !ns.some(x => /short/.test(x)), ns);

  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  const minIn = await page.evaluate(`(() => { const i = [...${SR}.querySelectorAll('.sheet input[type=number]')][1];
      return i && { v: i.value, min: i.min, max: i.max }; })()`);
  ok('minimum-length setting is there: default 1, range 0.5-3',
     minIn && minIn.v === '1' && minIn.min === '0.5' && minIn.max === '3', minIn);

  const maxIn = await page.evaluate(`(() => { const i = ${SR}.querySelector('.sheet input[type=number]');
      return i && { v: i.value, min: i.min }; })()`);
  ok('Max lanes defaults to 0, meaning no cap', maxIn && maxIn.v === '0' && maxIn.min === '0', maxIn);

  const foot = await page.evaluate(`(() => { const f = ${SR}.querySelector('.foot'), a = f && f.querySelector('a');
      return f && { t: f.textContent, href: a && a.href, tgt: a && a.target }; })()`);
  ok('settings footer carries the version and the repo link',
     foot && foot.t.indexOf('v' + ver) >= 0 &&
     foot.href === 'https://github.com/EricZhou866/waveform-viewer' && foot.tgt === '_blank', foot);

  const setMin = (v) => page.evaluate(`(() => { const i = [...${SR}.querySelectorAll('.sheet input[type=number]')][1];
      i.value = '${v}'; i.dispatchEvent(new Event('change')); })()`);

  await setMin('0.5'); await sleep(200);
  await page.evaluate(`window.playSet(['blip.mp3','short.mp3'])`);
  await sleep(1800);
  ns = await names();
  ok('0.70s clip comes in once the cut-off is 0.5s', ns.some(x => /short/.test(x)), ns);
  ok('0.30s blip is still filtered at 0.5s', !ns.some(x => /blip/.test(x)), ns);

  await setMin('2'); await sleep(400);
  ns = await names();
  ok('raising the cut-off drops what no longer qualifies, keeps what does',
     !ns.some(x => /short/.test(x)) && ns.some(x => /ref/.test(x)), ns);
  await setMin('0.5');
  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);

  /* the grip sizes the panel, and the size sticks */
  const size = () => page.evaluate(`(() => ({ w: ${SR}.querySelector('.panel').getBoundingClientRect().width,
      h: parseFloat(getComputedStyle(${SR}.querySelector('.lanes')).maxHeight) }))()`);
  const before = await size();
  const grip = await page.evaluate(`(() => { const r = ${SR}.querySelector('.grip').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 120, grip.y - 90, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const after = await size();
  ok('dragging the grip widens the panel', after.w > before.w + 60, { before, after });
  ok('dragging the grip shortens the lane area', after.h < before.h - 40, { before, after });

  await page.reload(); await sleep(600);
  await page.evaluate(`window.playSet(['ref.mp3'])`);
  await sleep(1800);
  const restored = await size();
  ok('the panel size survives a reload',
     Math.abs(restored.w - after.w) < 3 && Math.abs(restored.h - after.h) < 3, { after, restored });

  /* six clips, default settings: every one gets a lane, and the list scrolls at
     the panel's own height — nothing is parked out of sight */
  await page.evaluate(`${SR}.querySelector('[data-act="clear"]').click()`);
  await sleep(300);
  await page.evaluate(`window.playSet(['c1.mp3','c2.mp3','c3.mp3','c4.mp3','c5.mp3','c6.mp3'])`);
  await sleep(3200);
  const many = await page.evaluate(`(() => { const b = ${SR}.querySelector('.lanes');
      return { n: b.querySelectorAll('.lane').length, sh: b.scrollHeight, ch: b.clientHeight,
               status: ${SR}.querySelector('.status').textContent }; })()`);
  ok('all six clips get a lane — nothing parked out of sight', many.n === 6, many);
  ok('nothing is left waiting in the queue', many.status.indexOf('waiting') === -1, many.status);
  ok('the lane list scrolls at the panel default height', many.sh > many.ch + 10, many);

  /* pop out to the standalone window, then dock back */
  await page.evaluate(`${SR}.querySelector('[data-act="pop"]').click()`);
  await sleep(2200);
  const panelPage = ctx.pages().find(p => p.url().includes('panel.html'));
  ok('Window opens the standalone panel', !!panelPage);
  if (panelPage) {
    await sleep(1200);
    ok('in-page panel steps aside while the window is up',
       (await page.evaluate(`getComputedStyle(document.getElementById('__wf_viewer_host')).display`)) === 'none');
    const info = await panelPage.evaluate(`(() => { const s = document.getElementById('__wf_viewer_host').shadowRoot;
        return { dock: !!s.querySelector('[data-act="dock"]'), pop: !!s.querySelector('[data-act="pop"]'),
                 of: getComputedStyle(s.querySelector('.lanes')).overflowY }; })()`);
    ok('the window has Dock and no Window button', info.dock && !info.pop, info);
    ok('the window lane area scrolls too', info.of === 'auto', info);

    await panelPage.evaluate(`document.getElementById('__wf_viewer_host').shadowRoot.querySelector('[data-act="dock"]').click()`);
    await sleep(2000);
    ok('Dock closes the standalone window', !ctx.pages().some(p => p.url().includes('panel.html')));
    ok('the in-page panel comes back after docking',
       (await page.evaluate(`getComputedStyle(document.getElementById('__wf_viewer_host')).display`)) === 'block');
  }

  /* a profile carrying the old default cap of 4 is lifted on load */
  const sw = ctx.serviceWorkers()[0];
  ok('background service worker is running', !!sw);
  if (sw) {
    await sw.evaluate(`chrome.storage.local.set({ settings: { maxLanes: 4, minDur: 1 } })`);
    await page.reload(); await sleep(600);
    await page.evaluate(`window.playSet(['c1.mp3','c2.mp3','c3.mp3','c4.mp3','c5.mp3'])`);
    await sleep(3000);
    const migrated = await page.evaluate(`(() => ({ n: ${SR}.querySelectorAll('.lane').length,
        cap: ${SR}.querySelector('.sheet input[type=number]').value }))()`);
    ok('an old profile stuck at the 4-lane default is migrated to no cap',
       migrated.cap === '0' && migrated.n === 5, migrated);
  }

  ok('no page JS errors', errors.length === 0, errors);
  await ctx.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
