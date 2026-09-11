/* Regenerates src/icons/*.png.
 *
 *   node store/make-icons.js
 *
 * The icon is two waveforms, one above the other, in the panel's own colours:
 * the extension exists to put one recording against another, so that is what
 * the mark shows. Drawn rather than stored as art so a colour or a proportion
 * can be changed in one place and every size stays consistent.
 */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const OUT = process.argv[2] || path.join(__dirname, '..', 'src', 'icons');

/* Two waveforms, one above the other, in the panel's own colours — the whole
   idea of the extension is one recording against another.
 *
 * Geometry is computed in each target size's own pixel grid rather than scaled
 * down from one master: at 16px a bar scaled from a 128px drawing lands on
 * half-pixels and turns to mush. Bar counts drop with the size for the same
 * reason — 11 bars is texture at 128px and noise at 16px. */
const A = [.50,.80,1.0,.62,.88,.72,.95,.55,.85,.68,.45];
const B = [.60,.90,.55,1.0,.70,.82,.48,.92,.62,.75,.52];

/* Small sizes get an explicit grid instead of a formula. At 16px the whole mark
   is 14 pixels wide: bar width, gap and row height have to be whole numbers
   chosen by hand, or the bars land on half pixels and the two rows smear into
   one grey band. Derived geometry is fine from 96px up. */
const GRID = {
  // The heights are hand-picked at these sizes too. Sampling the 11-value shape
  // down to five lands on near-equal neighbours, and a row of equal bars is a
  // block, not a waveform.
  16:  { pad: 1, n: 5, bw: 2, gap: 1, rowGap: 2, rad: 3, round: 0,
         a: [.40, 1.0, .55, .85, .35], b: [.85, .40, 1.0, .50, .70] },
  32:  { pad: 2, n: 6, bw: 3, gap: 2, rowGap: 4, rad: 7, round: 0,
         a: [.40, .80, 1.0, .50, .85, .40], b: [.80, .45, 1.0, .60, .90, .50] },
  48:  { pad: 4, n: 7, bw: 4, gap: 2, rowGap: 5, rad: 10, round: 1,
         a: [.38, .75, 1.0, .52, .88, .62, .42], b: [.80, .45, .95, .58, 1.0, .50, .72] }
};

function icon(size) {
  const g = GRID[size] || (() => {
    const pad = Math.round(size * 0.085), n = 11;
    const inner = size - pad * 2, bw = Math.round(inner / (n * 1.85));
    return { pad, n, bw, gap: (inner - bw * n) / (n - 1),
             rowGap: Math.round(size * 0.075), rad: Math.round(size * 0.22), round: Math.round(bw / 2) };
  })();
  const inner = size - g.pad * 2;
  const rowH = (inner - g.rowGap) / 2;
  const pick = (arr, own) => {
    if (own) return own;
    const step = (arr.length - 1) / (g.n - 1);
    return Array.from({ length: g.n }, (_, i) => arr[Math.round(i * step)]);
  };
  const bars = (vals, cy, colour, own) => pick(vals, own).map((v, i) => {
    const h = Math.max(g.bw, Math.round(v * rowH));
    const x = Math.round(g.pad + i * (g.bw + g.gap));
    return `<rect x="${x}" y="${Math.round(cy - h / 2)}" width="${g.bw}" height="${h}" rx="${g.round}" fill="${colour}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${g.rad}" fill="#151922"/>
    ${bars(A, g.pad + rowH / 2, '#8ecbff', g.a)}
    ${bars(B, g.pad + rowH + g.rowGap + rowH / 2, '#ffcf6b', g.b)}
  </svg>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ channel: 'chromium', headless: true });
  const pg = await b.newPage();
  for (const s of [16, 32, 48, 96, 128]) {
    await pg.setViewportSize({ width: s, height: s });
    await pg.setContent(`<body style="margin:0">${icon(s)}</body>`);
    await pg.screenshot({ path: path.join(OUT, `icon-${s}.png`), omitBackground: true });
  }
  await b.close();
  console.log('ok');
})();
