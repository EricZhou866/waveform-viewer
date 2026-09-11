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
  // Decodes during parse — as early as a page realistically can, which is what
  // makes it a fair test of "the switch is off, do not touch this page".
  'auto.html': Buffer.from(`<!doctype html><meta charset="utf-8"><title>auto</title>
<h3>decodes on load</h3>
<script>
window.playSet = async (list) => {
  const ctx = new AudioContext();
  for (const f of list) {
    const a = await ctx.decodeAudioData(await (await fetch(f)).arrayBuffer());
    const s = ctx.createBufferSource(); s.buffer = a;
  }
};
window.playSet(['ref.mp3', 'mine.mp3']);
</script>`),
  'b.html': Buffer.from('<!doctype html><meta charset="utf-8"><title>quiet page</title><h3>no audio here</h3>'),
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

  /* the toolbar is icons, and it is legible */
  const tools = await page.evaluate(`(() => {
      const out = { labels: [], hidden: [], btn: 0, ico: 0 };
      ${SR}.querySelectorAll('.tools .btn').forEach(b => {
        out.labels.push(b.dataset.act + ':' + b.textContent);
        if (getComputedStyle(b).display === 'none') out.hidden.push(b.dataset.act);
      });
      out.btn = parseFloat(getComputedStyle(${SR}.querySelector('[data-act="settings"]')).fontSize);
      out.ico = parseFloat(getComputedStyle(${SR}.querySelector('.lane .ico')).fontSize);
      out.icoColor = getComputedStyle(${SR}.querySelector('.lane .ico')).color;
      return out; })()`);
  ok('every toolbar button is an icon, no text labels',
     tools.labels.every(l => l.split(':')[1].length <= 2), tools.labels);
  ok('Play, Files and Clear sit together at the front',
     tools.labels.slice(0, 3).map(l => l.split(':')[0]).join() === 'play,files,clear', tools.labels);
  ok('Shift, lane height and Rescan are hidden by default',
     ['move', 'taller', 'shorter', 'rescan'].every(a => tools.hidden.indexOf(a) >= 0), tools.hidden);
  ok('toolbar icons are big enough to read', tools.btn >= 14, tools.btn);
  ok('lane icons are big enough, and light enough to see',
     tools.ico >= 14 && tools.icoColor !== 'rgb(133, 147, 173)', tools);

  // Pick the checkbox by its label, not by position: the settings sheet grows.
  const extraShown = async (on) => {
    await page.evaluate(`(() => {
        const row = [...${SR}.querySelectorAll('.sheet .row')]
          .find(r => r.textContent.indexOf('Show extra buttons') >= 0);
        const cb = row.querySelector('input[type=checkbox]');
        cb.checked = ${on}; cb.dispatchEvent(new Event('change')); })()`);
    await sleep(200);
    return page.evaluate(`['move','taller','shorter','rescan'].every(a =>
        getComputedStyle(${SR}.querySelector('[data-act="' + a + '"]')).display !== 'none')`);
  };
  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  ok('the setting brings the extra buttons back', (await extraShown(true)) === true);
  ok('and takes them away again', (await extraShown(false)) === false);
  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);

  /* minimised, the panel should get out of the way */
  const wide = await page.evaluate(`${SR}.querySelector('.panel').getBoundingClientRect().width`);
  await page.evaluate(`${SR}.querySelector('[data-act="fold"]').click()`);
  await sleep(250);
  const narrow = await page.evaluate(`${SR}.querySelector('.panel').getBoundingClientRect().width`);
  ok('minimised, the panel shrinks to its buttons', narrow < 200 && narrow < wide / 2, { wide, narrow });
  await page.evaluate(`${SR}.querySelector('[data-act="fold"]').click()`);
  await sleep(250);

  const names = () => page.evaluate(`[...${SR}.querySelectorAll('.lane .name')].map(n => n.textContent)`);
  let ns = await names();
  ok('the 4.70s and 3.0s clips got lanes', ns.length === 2, ns);
  ok('0.30s blip filtered out', !ns.some(x => /blip/.test(x)), ns);
  ok('0.70s clip filtered out at the 2s default', !ns.some(x => /short/.test(x)), ns);

  /* arriving audio is cropped and aligned with no click */
  const meta = () => page.evaluate(`(() => [...${SR}.querySelectorAll('.lane')].map(l => ({
      name: l.querySelector('.name').textContent,
      meta: l.querySelector('.meta').textContent,
      off:  l.querySelector('.off').textContent }))) ()`);
  let ms = await meta();
  ok('new audio is cropped on arrival', ms.length === 2 && ms.every(m => m.meta.indexOf('\u2702') >= 0), ms);
  ok('the 4.70s clip is cropped down to its sound', ms.length === 2 && parseFloat(ms[0].meta) < 3, ms);
  ok('cropped lanes all start at zero', ms.every(m => m.off === ''), ms);
  ok('the Align button reads as on', await page.evaluate(`${SR}.querySelector('[data-act="align"]').classList.contains('on')`));

  /* turning Align off restores the full clips, and later arrivals stay whole */
  await page.evaluate(`${SR}.querySelector('[data-act="align"]').click()`);
  await sleep(300);
  ms = await meta();
  ok('clicking Align restores the full clips', ms.every(m => m.meta.indexOf('\u2702') < 0), ms);
  await page.evaluate(`window.playSet(['c6.mp3'])`);
  await sleep(1600);
  ms = await meta();
  ok('audio arriving while Align is off is left whole',
     ms.length === 3 && ms.every(m => m.meta.indexOf('\u2702') < 0), ms);
  await page.evaluate(`${SR}.querySelector('[data-act="align"]').click()`);
  await sleep(300);
  ms = await meta();
  ok('clicking Align again crops everything, including the late arrival',
     ms.length === 3 && ms.every(m => m.meta.indexOf('\u2702') >= 0), ms);
  await page.evaluate(`${SR}.querySelector('[data-act="clear"]').click()`);
  await sleep(200);
  await page.evaluate(`window.playSet(['ref.mp3','mine.mp3'])`);
  await sleep(2200);

  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  const minIn = await page.evaluate(`(() => { const i = [...${SR}.querySelectorAll('.sheet input[type=number]')][1];
      return i && { v: i.value, min: i.min, max: i.max }; })()`);
  ok('minimum-length setting is there: default 2, range 0.5-10',
     minIn && minIn.v === '2' && minIn.min === '0.5' && minIn.max === '10', minIn);

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

  /* every edge and corner resizes, and each advertises the right cursor */
  const cursors = await page.evaluate(`(() => { const out = {};
      ${SR}.querySelectorAll('.rs').forEach(h => { out[h.dataset.rs] = getComputedStyle(h).cursor; });
      out.grip = getComputedStyle(${SR}.querySelector('.grip')).cursor;
      return out; })()`);
  ok('all eight edges and corners have a handle', Object.keys(cursors).length === 9, cursors);
  ok('vertical edges use a vertical cursor, not a diagonal one',
     cursors.n === 'ns-resize' && cursors.s === 'ns-resize' && cursors.grip === 'ns-resize', cursors);
  ok('horizontal edges use a horizontal cursor', cursors.e === 'ew-resize' && cursors.w === 'ew-resize', cursors);
  ok('corners use the matching diagonal cursors',
     cursors.nw === 'nwse-resize' && cursors.se === 'nwse-resize' &&
     cursors.ne === 'nesw-resize' && cursors.sw === 'nesw-resize', cursors);

  // Park the panel somewhere known first: the edge drags below move it around,
  // and a handle that has drifted off-screen cannot be clicked.
  const moveTo = async (x, y) => {
    const g = await page.evaluate(`(() => { const t = ${SR}.querySelector('.title').getBoundingClientRect();
        const p = ${SR}.querySelector('.panel').getBoundingClientRect();
        return { tx: t.left + 20, ty: t.top + t.height / 2, pl: p.left, pt: p.top }; })()`);
    await page.mouse.move(g.tx, g.ty);
    await page.mouse.down();
    await page.mouse.move(g.tx + (x - g.pl), g.ty + (y - g.pt), { steps: 6 });
    await page.mouse.up();
    await sleep(200);
  };

  const dragEdge = async (which, dx, dy) => {
    const h = await page.evaluate(`(() => { const r = ${SR}.querySelector('.rs-${which}').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + dx, h.y + dy, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
  };
  const box = () => page.evaluate(`(() => { const r = ${SR}.querySelector('.panel').getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; })()`);

  await moveTo(360, 140);
  let b0 = await box();
  await dragEdge('w', -80, 0);
  let b1 = await box();
  ok('the west edge widens the panel and holds the right edge still',
     b1.l < b0.l - 40 && Math.abs(b1.r - b0.r) < 3, { b0, b1 });

  b0 = b1;
  await dragEdge('n', 0, -70);
  b1 = await box();
  ok('the north edge grows the panel upward and holds the bottom still',
     b1.t < b0.t - 30 && Math.abs(b1.b - b0.b) < 3, { b0, b1 });

  b0 = b1;
  await dragEdge('e', 60, 0);
  b1 = await box();
  ok('the east edge widens the panel and holds the left edge still',
     b1.r > b0.r + 30 && Math.abs(b1.l - b0.l) < 3, { b0, b1 });

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
  ok('the grip is the bottom edge: height only, width untouched',
     after.h < before.h - 40 && Math.abs(after.w - before.w) < 3, { before, after });

  await moveTo(300, 120);
  const beforeSE = await size();
  await dragEdge('se', 90, 70);
  const afterSE = await size();
  ok('the south-east corner resizes both ways at once',
     afterSE.w > beforeSE.w + 40 && afterSE.h > beforeSE.h + 30, { beforeSE, afterSE });

  const sized = await size();
  await page.reload(); await sleep(600);
  await page.evaluate(`window.playSet(['ref.mp3'])`);
  await sleep(1800);
  const restored = await size();
  ok('the panel size survives a reload',
     Math.abs(restored.w - sized.w) < 3 && Math.abs(restored.h - sized.h) < 3, { sized, restored });

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

  /* The switch is global, but the panel it creates must not be: a panel showing
     up in a tab the user was not even looking at reads as a bug, and it breaks
     the rule that a panel exists because a lane does. */
  const pageB = await ctx.newPage();
  await pageB.goto('https://wf.test/b.html');
  await sleep(800);
  const hasPanel = (p) => p.evaluate(`!!document.getElementById('__wf_viewer_host')`);
  ok('a page with no audio starts with no panel', (await hasPanel(pageB)) === false);

  const swT = ctx.serviceWorkers()[0];
  const toggleFrom = (url) => swT.evaluate(`(async () => {
      const [t] = await chrome.tabs.query({ url: ${JSON.stringify('https://wf.test/b.html')} });
      return toggleEnabled(t);
    })()`);
  const toggleAny = () => swT.evaluate(`(async () => {
      const [t] = await chrome.tabs.query({});
      return toggleEnabled(t);
    })()`);
  await toggleFrom(); await sleep(900);
  ok('turning it off clears the panel everywhere',
     (await hasPanel(page)) === false && (await hasPanel(pageB)) === false);

  await toggleFrom(); await sleep(1400);
  const onA = await hasPanel(page), onB = await hasPanel(pageB);
  ok('turning it on gives a panel to the tab whose button was clicked', onB === true, { onA, onB });
  ok('turning it on does NOT open a panel in another tab that has no audio', onA === false, { onA, onB });
  await pageB.close();

  /* Switched off, a page opened afterwards must be left completely alone: no
     panel, and none of the page's own globals patched. The content script only
     learns the switch state asynchronously, so anything that acts on a default
     of "on" acts before it knows. */
  await toggleAny();                       // off
  await sleep(800);
  const pageC = await ctx.newPage();
  await pageC.goto('https://wf.test/auto.html');
  await sleep(3000);
  const offState = await pageC.evaluate(`({
    panel: !!document.getElementById('__wf_viewer_host'),
    nativeDecode: /\\[native code\\]/.test((window.BaseAudioContext || window.AudioContext).prototype.decodeAudioData.toString()),
    nativeFetch: /\\[native code\\]/.test(window.fetch.toString())
  })`);
  ok('switched off, a page that plays on load gets no panel', offState.panel === false, offState);
  ok('switched off, the page-world hook is not installed at all',
     offState.nativeDecode === true && offState.nativeFetch === true, offState);

  await toggleAny();                       // back on
  await sleep(1200);
  await pageC.evaluate(`window.playSet(['ref.mp3'])`);
  await sleep(2500);
  ok('switching it back on injects the hook into a tab that never had it',
     (await pageC.evaluate(`!!document.getElementById('__wf_viewer_host')`)) === true);
  await pageC.close();

  /* ✕ closes the panel on this page, and the toolbar button brings it back */
  await page.evaluate(`window.playSet(['ref.mp3'])`);
  await sleep(2200);
  ok('there is a panel to close', (await page.evaluate(`!!${SR}`)) === true);
  await page.evaluate(`${SR}.querySelector('[data-act="hide"]').click()`);
  await sleep(400);
  const closed = await page.evaluate(`({
      hidden: getComputedStyle(document.getElementById('__wf_viewer_host')).display === 'none',
      lanes: ${SR}.querySelectorAll('.lane').length })`);
  ok('closing hides the panel and takes its lanes with it',
     closed.hidden === true && closed.lanes === 0, closed);
  await page.evaluate(`window.playSet(['mine.mp3'])`);
  await sleep(2000);
  ok('a closed panel stays closed when new audio arrives',
     (await page.evaluate(`getComputedStyle(document.getElementById('__wf_viewer_host')).display`)) === 'none');
  await toggleAny(); await sleep(700);       // off
  await toggleAny(); await sleep(1000);      // on, from this tab
  ok('the toolbar button brings the closed panel back',
     (await page.evaluate(`getComputedStyle(document.getElementById('__wf_viewer_host')).display`)) === 'block');

  /* a profile carrying the old default cap of 4 is lifted on load */
  const sw = ctx.serviceWorkers()[0];
  ok('background service worker is running', !!sw);
  if (sw) {
    await sw.evaluate(`chrome.storage.local.set({ settings: { v: 1, maxLanes: 4, minDur: 1 } })`);
    await page.reload(); await sleep(600);
    // c1 (1.56s) and c2 (1.87s) fall under the migrated 2s floor; c3-c5 clear it
    await page.evaluate(`window.playSet(['c1.mp3','c2.mp3','c3.mp3','c4.mp3','c5.mp3'])`);
    await sleep(3000);
    const migrated = await page.evaluate(`(() => { const ins = [...${SR}.querySelectorAll('.sheet input[type=number]')];
        return { n: ${SR}.querySelectorAll('.lane').length, cap: ins[0].value, min: ins[1].value }; })()`);
    ok('an old profile stuck at the 4-lane default is migrated to no cap', migrated.cap === '0', migrated);
    ok('an old profile stuck at the 1s minimum is migrated to 2s',
       migrated.min === '2' && migrated.n === 3, migrated);
  }

  ok('no page JS errors', errors.length === 0, errors);
  await ctx.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
