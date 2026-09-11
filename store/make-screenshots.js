/* Regenerates the store screenshots against the built extension.
 *
 *   ./build.sh && node store/make-screenshots.js
 *
 * Run it whenever the panel's look changes: shipping screenshots of a toolbar
 * the user will not find once they install is worse than shipping none.
 * Same Chromium setup as test/e2e.js — see DESIGN.md §20.3 for why the system
 * Chrome cannot be used. The page behind the panel is test/demo.html, a mock
 * practice page that imitates nobody.
 */
const { chromium } = require('playwright');
const path = require('path'), os = require('os'), fs = require('fs');
const REPO = path.join(__dirname, '..');
const EXT = path.join(REPO, 'build', 'chrome');
const OUT = path.join(REPO, 'store', 'screenshots');
const SR_HZ = 44100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SR = `document.getElementById('__wf_viewer_host').shadowRoot`;

/* Speech-shaped audio. Pure tones render as solid rectangles, which is not what
   anyone's recording looks like; a store screenshot showing that is a lie about
   what the tool draws. Syllables get an attack/decay envelope, a drifting pitch
   and a little noise, so the waveform has the bursts and gaps of real speech. */
function syllable(dur, amp, f0, noisy) {
  const n = Math.round(dur * SR_HZ), out = new Float32Array(n);
  const atk = Math.max(1, n * 0.12), dec = Math.max(1, n * 0.45);
  for (let i = 0; i < n; i++) {
    const env = i < atk ? i / atk : Math.min(1, (n - i) / dec);
    const f = f0 * (1 - 0.12 * (i / n));
    const t = i / SR_HZ;
    let v = Math.sin(2 * Math.PI * f * t) * 0.6
          + Math.sin(4 * Math.PI * f * t) * 0.25
          + Math.sin(6 * Math.PI * f * t) * 0.12;
    if (noisy) v = v * 0.35 + (Math.random() * 2 - 1) * 0.5;
    out[i] = v * env * amp;
  }
  return out;
}
const gap = (d) => new Float32Array(Math.round(d * SR_HZ));
function wav(parts) {
  let len = 0; for (const p of parts) len += p.length;
  const data = Buffer.alloc(len * 2);
  let o = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p[i] * 32767))), o);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR_HZ, 24); h.writeUInt32LE(SR_HZ * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
// "Just wait a minute, I will be with you shortly."
const say = (spec, base) => {
  const out = [];
  for (const s of spec) out.push(typeof s === 'number' ? gap(s) : syllable(s[0], s[1], base * s[2], s[3]));
  return out;
};
const WORDS = [
  [0.20, 0.75, 1.00, true], 0.05, [0.26, 0.85, 1.06], 0.07, [0.10, 0.50, 0.94],
  0.05, [0.17, 0.80, 1.10], [0.19, 0.60, 0.90, true],
  0.42,                                    // the pause after "minute"
  [0.16, 0.70, 1.12], 0.05, [0.20, 0.72, 1.00], 0.05, [0.14, 0.62, 0.95],
  0.05, [0.17, 0.68, 1.04, true], 0.05, [0.15, 0.64, 0.92],
  0.06, [0.24, 0.80, 1.08, true], [0.22, 0.55, 0.86]
];
// the learner's take: a longer hesitation, and the tail rushed
const MINE = [
  [0.22, 0.62, 1.00, true], 0.06, [0.30, 0.70, 1.04], 0.09, [0.12, 0.42, 0.92],
  0.06, [0.19, 0.66, 1.08], [0.21, 0.50, 0.88, true],
  0.78,                                    // hesitates twice as long
  [0.14, 0.58, 1.10], 0.04, [0.16, 0.60, 1.00], 0.04, [0.11, 0.50, 0.94],
  0.04, [0.14, 0.56, 1.02, true], 0.04, [0.12, 0.52, 0.90],
  0.05, [0.19, 0.66, 1.06, true], [0.17, 0.45, 0.85]
];
/* The lane label comes from the file name, and in a store screenshot that label
   is doing the explaining. "Model answer" beats "ref.mp3". The demo page is
   served with its references rewritten to match; the repo copy is untouched. */
const FILES = {
  'Model answer.mp3':   wav([gap(0.5), ...say(WORDS, 165), gap(0.6)]),
  'Your recording.mp3': wav([gap(0.8), ...say(MINE, 128),  gap(0.5)]),
  'demo.html': Buffer.from(fs.readFileSync(path.join(REPO, 'test', 'demo.html'), 'utf8')
    .replace(/ref\.mp3/g, 'Model answer.mp3')
    .replace(/mine\.mp3/g, 'Your recording.mp3'))
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
           '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1
  });
  await ctx.route('https://practice.example/**', (route) => {
    // decode: the file names have spaces in them, and the URL does not
    const n = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'demo.html';
    const b = FILES[n];
    if (!b) return route.fulfill({ status: 404, body: 'no' });
    route.fulfill({ status: 200, body: b, contentType: n.endsWith('.html') ? 'text/html' : 'audio/mpeg' });
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://practice.example/demo.html');
  await sleep(700);
  await page.click('[data-f="Model answer.mp3"]');
  await sleep(1500);
  await page.click('[data-f="Your recording.mp3"]');
  await sleep(2500);

  await page.screenshot({ path: path.join(OUT, '01-compare.png') });

  // drag across the pause on the second lane, so the gap readout is on screen
  const box = await page.evaluate(`(() => {
      const c = [...${SR}.querySelectorAll('.lane canvas')][1].getBoundingClientRect();
      return { x: c.left, y: c.top + c.height / 2, w: c.width }; })()`);
  await page.mouse.move(box.x + box.w * 0.40, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.56, box.y, { steps: 12 });
  await page.mouse.up();
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '02-measure.png') });

  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '04-settings.png') });
  await page.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await sleep(300);

  await page.evaluate(`${SR}.querySelector('[data-act="pop"]').click()`);
  await sleep(3000);
  const win = ctx.pages().find(p => p.url().includes('panel.html'));
  if (win) {
    await win.setViewportSize({ width: 1280, height: 800 });
    await sleep(1200);
    await win.screenshot({ path: path.join(OUT, '03-window.png') });
  }
  await ctx.close();
  console.log('written to', OUT);
})();
