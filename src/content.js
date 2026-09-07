/* Waveform Viewer — content script */
(() => {
'use strict';
if (window.__wfViewerLoaded) return;
window.__wfViewerLoaded = true;

const api = (typeof browser !== 'undefined') ? browser : chrome;

/* Two contexts run this file:
   - as a content script inside a web page (discovery + in-page panel)
   - as the standalone panel window (panel.html), an extension page
   The standalone window is a real browser window, so it can be moved to a
   second monitor. Cross-window DOM adoption (the old approach) is not portable
   across engines, so the panel window is its own page instead. */
const IS_PANEL = /-extension:$/.test(location.protocol);

/* User-visible settings, persisted in extension storage. */
const SETTINGS_V = 3;   // bumped when a default changes in a way that must migrate
const DEFAULTS = {
  v: SETTINGS_V,
  maxLanes: 0,          // 0 = no cap: every clip gets a lane, and the list scrolls
  autoAlign: true,      // new audio arrives cropped and aligned
  whenFull: 'keep',     // 'keep' = never discard silently | 'replace' = evict oldest
  sync: true,           // one shared time scale across lanes
  gain: 'auto',         // 'auto' | 1 | 2 | 4 | 8
  trimOnAlign: true,    // Align also crops leading/trailing silence
  trimThresh: 0.08,     // silence threshold, fraction of the clip's own peak
  minDur: 2             // clips shorter than this many seconds are ignored
};
let cfg = Object.assign({}, DEFAULTS);
const PEAK_RES  = 8192;
const MIN_DUR_LO = 0.5, MIN_DUR_HI = 10;
/* Shortest clip worth a lane. User-settable because the right cut-off depends on
   the site: players fire silent primers of a few ms, but ad stingers and UI blips
   can run most of a second and are just as unwanted. */
const minDur = () => Math.max(MIN_DUR_LO, Math.min(MIN_DUR_HI, Number(cfg.minDur) || DEFAULTS.minDur));

const VERSION = (() => { try { return api.runtime.getManifest().version || ''; } catch (e) { return ''; } })();
const REPO_URL = 'https://github.com/EricZhou866/waveform-viewer';

const COLOR = {
  field:'#c9dcf7', fieldMute:'#aab4c6', wave:'#15171d', waveMute:'#6b7688',
  zero:'#0b0d12', dead:'#39414f', ruler:'#262b36', tick:'#8ea3c6',
  tickHi:'#dce7f8', label:'#b8c8e4', cursor:'#e5484d',
  selFill:'rgba(255,255,255,.30)', selEdge:'#f0f3f8'
};

let enabled = true;
let host = null, shadow = null, lanesBox = null, statusEl = null;
let audioCtx = null;
let laneH = 96, panelW = 640;
let panelH = 0;          // height of the scrolling lane area, in-page mode
/* Until the user drags a vertical edge the panel hugs its content and panelH is
   only a ceiling. After that it is the height they asked for, empty space and
   all — a panel that silently shrinks back is not a panel you can size. */
let panelHSet = false;
let gainVal = 1;
/* Audio found while the panel was full. Nothing is thrown away: it waits here
   and slots in as soon as a lane frees up or the limit is raised. */
const parked = [];
const PARK_MAX = 12;
/* A cap only exists if the user asks for one. This is the backstop against a
   session that runs for hours: every lane holds a decoded AudioBuffer, so an
   unbounded list is an unbounded memory leak. Reaching it is reported, never
   silent. */
const LANE_HARD_MAX = 64;
const laneCap = () => {
  const n = Math.max(0, parseInt(cfg.maxLanes, 10) || 0);
  return n > 0 ? Math.min(n, LANE_HARD_MAX) : LANE_HARD_MAX;
};

/* Sources that turned out not to be usable audio — typically the silent
   `data:` primer many players fire before every playback to unlock the audio
   context. Remembered so they are not fetched and decoded over and over. */
const rejected = new Set();
let moveMode = false;
/* Whether the panel is in the aligned state. Explicit rather than derived from
   "does any lane have a trim", because a lane arriving later has to know which
   state to join. Seeded from cfg.autoAlign, flipped by the Align button. */
let aligned = true;
/* The window the panel currently lives in: this page when docked, the popup when
   popped out. Drag handlers, rAF, DPI and sizing must all go through it, otherwise
   everything breaks once the panel is moved to another monitor. */
const winOf = () => (host && host.ownerDocument && host.ownerDocument.defaultView) || window;

const lanes     = new Map();
const peakCache = new Map();
const seenMedia = new WeakSet();
const seenDec   = new Set();
const stat = { media: 0, url: 0, dec: 0, hook: false };

/* transport state */
const T = { playing: false, ctxStart: 0, posStart: 0, pos: 0, sources: [], raf: 0 };

const actx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

/* ============================ helpers ============================ */
function fmtSec(t) {
  if (!isFinite(t) || t < 0) return '--';
  if (t < 60) return t.toFixed(2) + 's';
  const m = Math.floor(t / 60);
  return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
}
const srcOf = (el) => { try { return el.currentSrc || el.src || ''; } catch { return ''; } };

function nameFromUrl(u) {
  if (!u) return 'audio';
  if (u.startsWith('blob:')) return 'clip ' + (lanes.size + 1);
  if (u.startsWith('data:')) return 'data audio';
  try {
    const p = new URL(u, location.href);
    return decodeURIComponent((p.pathname.split('/').pop() || '').trim()) || p.hostname;
  } catch { return 'audio'; }
}

/* Returns '' instead of throwing. On Firefox an ArrayBuffer that came from
   another compartment makes `new Uint8Array(buf)` raise "Permission denied to
   access property constructor", and that must never take the caller down. */
function bufToB64(buf) {
  try {
    const u8 = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let out = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return out ? btoa(out) : '';
  } catch (e) { return ''; }
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/* ============ inject the page-world hook ============ */
(function inject() {
  try {
    const s = document.createElement('script');
    s.src = api.runtime.getURL('page-hook.js');
    s.onload = () => s.remove();
    s.onerror = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();

/* The page-world hook talks to us over window.postMessage — the only channel
   that works on both Chrome and Firefox. Treat everything here as untrusted
   input from the page: we only ever use it to draw a waveform. */
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__wf !== 1 || typeof d.kind !== 'string') return;
  if (!enabled) return;
  stat.hook = true;

  if (d.kind === 'ready') { paintStatus(); return; }

  if (d.kind === 'url' && typeof d.url === 'string') {
    offerUrl(d.url);
    return;
  }

  if (d.kind === 'decoded' && d.mins && d.maxs && d.mins.length === d.maxs.length) {
    const id = 'dec' + d.id;
    if (seenDec.has(id)) return;
    seenDec.add(id); stat.dec++;
    const peaks = {
      mins: Float32Array.from(d.mins),
      maxs: Float32Array.from(d.maxs),
      duration: Number(d.duration) || 0
    };
    if (!(peaks.duration >= minDur())) return;     // primer or blip, ignore
    const url = typeof d.url === 'string' ? d.url : '';
    if (url && isJunkSource(url)) return;
    offer({
      key: url ? 'src:' + url : id,
      url,
      label: url ? nameFromUrl(url) : 'Web Audio #' + d.id,
      peaks, duration: peaks.duration
    });
    paintStatus();
  }
});

/* ============================ discovery ============================ */
/* Manual recovery: re-scan the DOM and ask the page-world hook to re-announce
   the audio it has seen, for sites that replay without a fresh request. */
function rescan() {
  scanDom();
  try { window.postMessage({ __wfCmd: 'rescan' }, '*'); } catch (e) {}
}

function scanDom() {
  try { document.querySelectorAll('audio, video').forEach(offerMedia); } catch (e) {}
  paintStatus();
}

new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (!(n instanceof Element)) continue;
    if (n.matches && n.matches('audio, video')) offerMedia(n);
    if (n.querySelectorAll) n.querySelectorAll('audio, video').forEach(offerMedia);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

['loadedmetadata', 'play', 'canplay'].forEach(ev =>
  document.addEventListener(ev, (e) => {
    if (e.target instanceof HTMLMediaElement) offerMedia(e.target);
  }, true));

function offerMedia(el) {
  if (!enabled || !(el instanceof HTMLMediaElement)) return;
  if (!seenMedia.has(el)) {
    seenMedia.add(el); stat.media++;
    ['loadedmetadata', 'canplay', 'durationchange'].forEach(ev =>
      el.addEventListener(ev, () => offerMedia(el)));
  }
  const url = srcOf(el);
  if (!url) return;
  if (el.duration && el.duration < minDur()) return;
  offer({ key: 'src:' + url, url, label: nameFromUrl(url), el });
}

/* A `data:` URI this small cannot hold anything worth drawing — it is a primer
   clip, not content. Filtered before a lane is ever built. */
const TINY_DATA_URI = 3000;

function isJunkSource(url) {
  if (!url) return true;
  if (rejected.has(url)) return true;
  if (url.startsWith('data:') && url.length < TINY_DATA_URI) return true;
  return false;
}

function offerUrl(url) {
  if (!enabled || !url || isJunkSource(url)) return;
  const key = 'src:' + url;
  if (!lanes.has(key)) stat.url++;
  offer({ key, url, label: nameFromUrl(url) });
}

function offer(spec) {
  if (!enabled) return;
  if (spec.url && isJunkSource(spec.url)) return;
  const ex = lanes.get(spec.key);
  if (ex) {
    let changed = false;
    if (spec.el && !ex.el) { ex.el = spec.el; wireMedia(ex); changed = true; }
    if (spec.buffer && !ex.buffer) { ex.buffer = spec.buffer; changed = true; }
    if (spec.raw && !ex.raw) { ex.raw = spec.raw; ex.mime = spec.mime || ex.mime; }
    if (spec.peaks && !ex.peaks) {
      ex.peaks = spec.peaks;
      ex.duration = spec.duration || spec.peaks.duration || 0;
      ex.metaEl.textContent = fmtSec(ex.duration);
      changed = true;
    }
    if (changed) refreshAll();
    return;
  }
  createLane(spec);
}

/* ============================ timeline ============================ */
/* The visible span is decided by the clips themselves, never by their offsets.
   That is what makes Shift feel right: the ruler stays put and the waveform
   slides across it. (Previously the span grew with the offsets, so the axis
   rescaled and the waveform appeared frozen.) */
function timeline() {
  let span = 0.1;
  for (const l of lanes.values()) span = Math.max(span, visDur(l));
  return { t0: 0, t1: span, span };
}

/* Visible length of a lane: the whole clip, or just the trimmed region. */
function visDur(lane) {
  const full = lane.duration || (lane.el && lane.el.duration) || 0;
  if (lane.trimB == null) return full;
  return Math.max(0.05, lane.trimB - lane.trimA);
}

function laneAxis(lane) {
  if (cfg.sync) { const g = timeline(); return { t0: g.t0, span: g.span }; }
  return { t0: 0, span: Math.max(0.1, visDur(lane)) };
}

/* ======================= playback engine (Web Audio) ======================= */
/* stopAll()      — stop and stay where you are (used when restarting)
   stopAll(true)  — stop and rewind to the start (used when playback ends) */
function stopAll(rewind) {
  T.sources.forEach(s => { try { s.stop(); } catch (e) {} });
  T.sources = [];
  T.playing = false;
  winOf().cancelAnimationFrame(T.raf);
  if (rewind) T.pos = timeline().t0;
  paintTransport();
  paintAllCursors();
}

function playAll(fromPos) {
  const ctx = actx();
  if (ctx.state === 'suspended') ctx.resume();
  stopAll();          // stop whatever is running, keep the requested position

  // Pause the page's own player so we don't hear two copies at once
  for (const l of lanes.values()) if (l.el && !l.el.paused) { try { l.el.pause(); } catch (e) {} }

  const g = timeline();
  let pos = fromPos != null ? fromPos : T.pos;
  if (!isFinite(pos) || pos < g.t0 || pos >= g.t1 - 0.02) pos = g.t0;

  const now = ctx.currentTime + 0.06;
  let any = false;
  for (const l of lanes.values()) {
    if (!l.buffer || l.muted) continue;
    const s = l.offset, e = l.offset + visDur(l);
    if (pos >= e) continue;
    const src = ctx.createBufferSource();
    src.buffer = l.buffer;
    src.connect(ctx.destination);
    // Play from the trimmed start, so cropped silence is really skipped.
    const into = (l.trimA || 0) + Math.max(0, pos - s);
    src.start(now + Math.max(0, s - pos), into, Math.max(0.01, visDur(l) - Math.max(0, pos - s)));
    T.sources.push(src);
    any = true;
  }
  if (!any) { paintTransport(); return; }

  T.playing = true; T.ctxStart = now; T.posStart = pos; T.pos = pos;
  paintTransport();
  tickTransport();
}

function tickTransport() {
  const ctx = actx();
  const g = timeline();
  T.pos = T.posStart + (ctx.currentTime - T.ctxStart);
  if (T.pos >= g.t1) { stopAll(true); return; }   // reached the end: rewind
  paintAllCursors();
  T.raf = winOf().requestAnimationFrame(tickTransport);
}

function toggleAll() { T.playing ? stopAll(true) : playAll(); }

function paintTransport() {
  if (!shadow) return;
  const b = shadow.querySelector('[data-act="play"]');
  if (b) { b.textContent = T.playing ? '■ Stop' : '▶ Play'; b.classList.toggle('on', T.playing); }
}

function paintAllCursors() { for (const l of lanes.values()) paintCursor(l); }

/* Align: crop the silence at both ends of every clip, then start them all at
   zero. Cropping is what actually lines the speech up — once the dead air is
   gone, "aligned" and "starts at 0" are the same thing. Click again to undo. */
function soundBounds(lane) {
  const { mins, maxs } = lane.peaks;
  const n = mins.length;
  if (!n) return null;

  // Work on a smoothed envelope. A single click or a stray blip in the tail
  // should not keep two seconds of near-silence alive.
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.max(maxs[i], -mins[i]);
  const K = Math.max(1, Math.round(n / 400));      // ~0.25% of the clip
  const sm = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += env[i];
    if (i >= K) acc -= env[i - K];
    sm[i] = acc / Math.min(K, i + 1);
  }

  let peak = 0;
  for (let i = 0; i < n; i++) if (sm[i] > peak) peak = sm[i];
  if (peak < 1e-5) return null;

  const thr = peak * cfg.trimThresh;
  // Sound has to hold for a moment before it counts, so quiet crackle at the
  // ends is cropped along with the true silence.
  const run = Math.max(2, Math.round(n / 200));    // ~0.5% of the clip

  let a = -1;
  for (let i = 0; i + run <= n; i++) {
    let held = true;
    for (let j = i; j < i + run; j++) if (sm[j] <= thr) { held = false; break; }
    if (held) { a = i; break; }
  }
  let b = -1;
  for (let i = n - 1; i - run >= 0; i--) {
    let held = true;
    for (let j = i; j > i - run; j--) if (sm[j] <= thr) { held = false; break; }
    if (held) { b = i; break; }
  }
  if (a < 0 || b < 0 || b <= a) return null;

  const dur = lane.duration;
  const pad = 0.05;                                 // keep a hair of air
  const A = Math.max(0, (a / n) * dur - pad);
  const B = Math.min(dur, ((b + 1) / n) * dur + pad);
  if (B - A < 0.15) return null;                    // refuse silly-short crops
  return { a: A, b: B };
}

function alignOnsets() {
  aligned = !aligned;
  applyAlign();
}

/* Bring one freshly-decoded lane into whatever state the panel is already in, so
   audio that shows up later needs no second click. Trimming is per-lane, so only
   the new lane is touched — a lane the user has shifted by hand stays put. The
   offset fallback has no such luxury: lining up onsets is a comparison across
   every lane, so that path re-runs the whole thing. */
function joinAlign(lane) {
  if (!aligned || !lane || !lane.peaks) return;
  if (!cfg.trimOnAlign) { applyAlign(); return; }
  const b = soundBounds(lane);
  if (b) { lane.trimA = b.a; lane.trimB = b.b; } else { lane.trimA = 0; lane.trimB = null; }
  lane.offset = 0;
  paintMeta(lane);
  refreshAll();
}

function applyAlign() {
  const on = aligned;
  for (const l of lanes.values()) {
    l.offset = 0;
    l.selA = l.selB = null;
    l.regEl.style.display = 'none';
    l.selEl.textContent = '';
    if (!on || !l.peaks || !cfg.trimOnAlign) { l.trimA = 0; l.trimB = null; continue; }
    const b = soundBounds(l);
    if (b) { l.trimA = b.a; l.trimB = b.b; } else { l.trimA = 0; l.trimB = null; }
  }
  // With trimming off, fall back to lining up the onsets by offset instead.
  if (on && !cfg.trimOnAlign) {
    const info = [];
    for (const l of lanes.values()) {
      if (!l.peaks) continue;
      const b = soundBounds(l);
      info.push({ lane: l, onset: b ? b.a : 0 });
    }
    if (info.length) {
      const target = Math.max(...info.map(x => x.onset));
      info.forEach(x => { x.lane.offset = target - x.onset; });
    }
  }
  T.pos = 0;
  paintAlignBtn();
  refreshAll();
}

function paintAlignBtn() {
  const btn = shadow && shadow.querySelector('[data-act="align"]');
  if (btn) btn.classList.toggle('on', aligned);
}

/* ============================ panel ============================ */
function ensurePanel() {
  if (host) return;
  if (!document.body) {
    addEventListener('DOMContentLoaded', () => { ensurePanel(); refreshAll(); }, { once: true });
    return;
  }
  host = document.createElement('div');
  host.id = '__wf_viewer_host';
  host.style.cssText = IS_PANEL
    // Standalone window: the host IS the window.
    ? 'position:static;display:block;width:100%;height:100vh;margin:0;padding:0;'
    // Inside a page: float above everything, and defend against page CSS.
    : 'position:fixed!important;z-index:2147483600!important;' +
      'right:16px!important;bottom:16px!important;display:block!important;' +
      'width:auto!important;height:auto!important;margin:0!important;padding:0!important;';
  document.body.appendChild(host);

  shadow = host.attachShadow({ mode: 'open' });
  if (!panelH) panelH = Math.max(180, Math.round(((winOf().innerHeight || 800) * 0.58)));
  const PANEL_CSS = `
      * { box-sizing:border-box; margin:0; padding:0;
          font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
      .panel { position:relative; width:${panelW}px; background:#1b1f28; color:#e8edf6;
        border:1px solid #39404e; border-radius:10px;
        box-shadow:0 10px 34px rgba(0,0,0,.45); overflow:hidden; user-select:none; }
      .bar { display:flex; align-items:center; gap:8px; padding:7px 10px;
        background:#232936; cursor:move; }
      .title { font-size:12.5px; font-weight:600; flex:1; }
      .ver { font-size:10.5px; color:#7d8aa3; font-weight:400; }
      .count { font-size:11px; color:#93a2bd; font-weight:400; }
      .tools { display:flex; align-items:center; gap:5px; flex-wrap:wrap;
        padding:0 10px 8px; background:#232936; border-bottom:1px solid #39404e; }
      .sep { width:1px; height:16px; background:#3d4658; margin:0 3px; }
      .btn { background:#313a4c; border:0; color:#cfd9ea; border-radius:5px;
        font-size:11.5px; padding:3px 8px; cursor:pointer; line-height:1.6; white-space:nowrap; }
      .btn:hover { background:#3d4860; color:#fff; }
      .btn.on { background:#3f6ea8; color:#fff; }
      .btn.play.on { background:#c2453f; }
      /* The lane area always scrolls. Without this, lanes past the fourth end up
         below the fold of a fixed-height panel and are simply invisible. */
      .lanes { max-height:${panelH}px; overflow-y:auto; overscroll-behavior:contain;
        scrollbar-width:thin; scrollbar-color:#4a556b #191d25; }
      .lanes::-webkit-scrollbar { width:10px; }
      .lanes::-webkit-scrollbar-track { background:#191d25; }
      .lanes::-webkit-scrollbar-thumb { background:#4a556b; border-radius:5px; }
      .lanes::-webkit-scrollbar-thumb:hover { background:#5c6982; }
      .lane { border-bottom:1px solid #2c3341; }
      .lane:last-child { border-bottom:0; }
      .lane.muted .name { color:#6f7c92; text-decoration:line-through; }
      .head { display:flex; align-items:center; gap:6px; padding:5px 9px; font-size:11.5px; color:#a9b7d0; }
      .name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#dbe4f3; }
      .name.playing { color:#7ee0a8; }
      .off { color:#7fc7f5; font-variant-numeric:tabular-nums; cursor:pointer; }
      .off:hover { color:#fff; }
      .meta { color:#8593ad; font-variant-numeric:tabular-nums; }
      .sel { color:#ffd479; font-variant-numeric:tabular-nums; font-weight:600; }
      .ico { background:transparent; border:0; cursor:pointer; font-size:12.5px;
        padding:0 3px; line-height:1; color:#8593ad; }
      .ico:hover { color:#fff; }
      .ico.on { color:#ffd479; }
      .ico.off2 { color:#e5484d; }
      .wrap { position:relative; margin:0 9px 8px; cursor:text; }
      .wrap.move { cursor:grab; }
      .wrap.move:active { cursor:grabbing; }
      canvas { display:block; width:100%; height:${laneH}px; border-radius:3px; }
      .cursor { position:absolute; top:0; bottom:14px; width:1px; background:${COLOR.cursor};
        pointer-events:none; box-shadow:0 0 3px ${COLOR.cursor}; display:none; }
      .region { position:absolute; top:0; bottom:14px; display:none; background:${COLOR.selFill};
        border-left:1px solid ${COLOR.selEdge}; border-right:1px solid ${COLOR.selEdge};
        pointer-events:none; }
      .msg { padding:8px 12px 12px; font-size:11.5px; color:#d98a8a; line-height:1.6; word-break:break-all; }
      .status { padding:6px 10px; font-size:10.5px; color:#7d8aa3; background:#191d25;
        border-top:1px solid #2c3341; }
      .status b { color:#a9b7d0; font-weight:600; }
      .empty { padding:18px 14px; text-align:center; font-size:12px; color:#7d8aa3; line-height:1.7; }
      /* Resize from any edge or corner, each with the cursor that matches the
         direction it actually moves in — a diagonal arrow on an edge that only
         moves vertically is a lie about what the drag will do. */
      .rs { position:absolute; z-index:5; }
      .rs-n  { top:0; left:10px; right:10px; height:5px; cursor:ns-resize; }
      .rs-s  { bottom:0; left:10px; right:10px; height:5px; cursor:ns-resize; }
      .rs-e  { right:0; top:10px; bottom:10px; width:5px; cursor:ew-resize; }
      .rs-w  { left:0; top:10px; bottom:10px; width:5px; cursor:ew-resize; }
      .rs-nw { top:0; left:0; width:12px; height:12px; cursor:nwse-resize; }
      .rs-se { bottom:0; right:0; width:12px; height:12px; cursor:nwse-resize; }
      .rs-ne { top:0; right:0; width:12px; height:12px; cursor:nesw-resize; }
      .rs-sw { bottom:0; left:0; width:12px; height:12px; cursor:nesw-resize; }
      .collapsed .rs, .panel.popped .rs { display:none; }
      .grip { height:12px; background:#232936; cursor:ns-resize; display:flex;
        align-items:center; justify-content:center; border-top:1px solid #39404e; }
      .grip::after { content:''; width:34px; height:3px; border-radius:2px; background:#4a556b; }
      .collapsed .lanes, .collapsed .grip, .collapsed .status, .collapsed .tools,
      .collapsed .sheet { display:none; }
      .sheet { background:#191d25; border-top:1px solid #2c3341; padding:4px 0 8px; }
      .sheetHead { display:flex; align-items:center; justify-content:space-between;
        padding:8px 12px 6px; font-size:12px; font-weight:600; color:#dbe4f3; }
      .row { display:flex; align-items:center; gap:12px; padding:5px 12px; }
      .rowLabel { flex:1; display:flex; flex-direction:column; font-size:11.5px; color:#c4cfe2; }
      .rowLabel small { color:#7d8aa3; font-size:10.5px; margin-top:1px; }
      .num { width:56px; }
      .num, .pick { background:#2b3444; color:#e8edf6; border:1px solid #3d4658;
        border-radius:5px; font-size:11.5px; padding:3px 6px; }
      .row input[type=checkbox] { width:15px; height:15px; accent-color:#3f6ea8; cursor:pointer; }
      .foot { margin-top:6px; padding:7px 12px 2px; border-top:1px solid #2c3341;
        font-size:10.5px; color:#7d8aa3; }
      .foot a { color:#7fc7f5; text-decoration:none; }
      .foot a:hover { text-decoration:underline; }
      /* popped out: fill the whole window */
      .panel.popped { width:100%!important; height:100vh; border:0; border-radius:0;
        display:flex; flex-direction:column; box-shadow:none; }
      .panel.popped .bar, .panel.popped .tools { flex:0 0 auto; }
      .panel.popped .status { flex:0 0 auto; }
      .panel.popped .bar { cursor:default; }
      .panel.popped .lanes { max-height:none; flex:1 1 auto; min-height:0; }
      .panel.popped .grip, .panel.popped [data-act="fold"] { display:none; }
    `;

  /* Built with createElement rather than innerHTML: no dynamic markup anywhere,
     which keeps the add-on linters (and reviewers) happy. */
  const mk = (tag, props) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'dataset') { for (const d in props.dataset) n.dataset[d] = props.dataset[d]; }
      else n[k] = props[k];
    }
    return n;
  };

  const styleEl = mk('style');
  styleEl.textContent = PANEL_CSS;
  shadow.appendChild(styleEl);

  const panel = mk('div', { className: 'panel' });

  const bar = mk('div', { className: 'bar' });
  const title = mk('span', { className: 'title', textContent: 'Waveform ' });
  if (VERSION) title.appendChild(mk('span', { className: 'ver', textContent: 'v' + VERSION + ' ' }));
  const count = mk('span', { className: 'count' });
  title.appendChild(count);
  bar.appendChild(title);
  bar.appendChild(mk('button', { className: 'btn', textContent: '\uff0d', dataset: { act: 'fold' } }));
  panel.appendChild(bar);

  const tools = mk('div', { className: 'tools' });
    tools.appendChild(mk('button', { className: 'btn play', textContent: '▶ Play', title: 'Play every un-muted lane together', dataset: { act: 'play' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '⇱ Align', title: 'Crop the silence at both ends of every clip and start them together. Click again to restore.', dataset: { act: 'align' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '↔ Shift', title: 'Drag the waveform sideways to shift a lane. Hold Shift to toggle temporarily.', dataset: { act: 'move' } }));
    tools.appendChild(mk('span', { className: 'sep' }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '⊕ Files', title: 'Open audio files from this computer', dataset: { act: 'files' } }));
    tools.appendChild(mk('span', { className: 'sep' }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '＋', title: 'Taller lanes', dataset: { act: 'taller' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '－', title: 'Shorter lanes', dataset: { act: 'shorter' } }));
    tools.appendChild(mk('span', { className: 'sep' }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '⧉ Window', title: 'Open the panel in its own window — move it to a second monitor', dataset: { act: 'pop' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '⇲ Dock', title: 'Close this window and put the panel back into the page', dataset: { act: 'dock' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: 'Rescan', title: 'Scan the page again', dataset: { act: 'rescan' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: 'Clear', title: 'Remove all lanes', dataset: { act: 'clear' } }));
    tools.appendChild(mk('button', { className: 'btn', textContent: '\u2699', title: 'Settings', dataset: { act: 'settings' } }));
  panel.appendChild(tools);

  const lanesEl  = mk('div', { className: 'lanes' });
  const statusBar = mk('div', { className: 'status' });
  const grip     = mk('div', { className: 'grip' });
  panel.appendChild(lanesEl);
  buildSettings(panel);
  panel.appendChild(statusBar);
  panel.appendChild(grip);
  ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(d =>
    panel.appendChild(mk('div', { className: 'rs rs-' + d, dataset: { rs: d } })));
  shadow.appendChild(panel);

  lanesBox = shadow.querySelector('.lanes');
  statusEl = shadow.querySelector('.status');

  const onTool = (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    const panel = shadow.querySelector('.panel');
    if (act === 'fold') {
      panel.classList.toggle('collapsed');
      e.target.textContent = panel.classList.contains('collapsed') ? '＋' : '－';
    } else if (act === 'play')   { toggleAll(); }
    else if (act === 'align')    { alignOnsets(); }
    else if (act === 'move')     { moveMode = !moveMode; e.target.classList.toggle('on', moveMode); applyCursorMode(); }
    else if (act === 'clear')    { stopAll(); parked.length = 0; [...lanes.keys()].forEach(dropLane); }
    else if (act === 'rescan')   { rescan(); }
    else if (act === 'pop')      { popOut(); }
    else if (act === 'dock')     { dockBack(); }
    else if (act === 'files')    { pickFiles(); }
    else if (act === 'taller' || act === 'shorter') {
      laneH = Math.max(56, Math.min(240, laneH + (act === 'taller' ? 26 : -26)));
      applySize();
    } else if (act === 'settings') {
      toggleSettings();
    }
  };
  shadow.querySelector('.bar').addEventListener('click', onTool);
  shadow.querySelector('.tools').addEventListener('click', onTool);

  if (IS_PANEL) {
    panel.classList.add('popped');
    ['pop', 'rescan', 'fold'].forEach(a => {
      const b = shadow.querySelector('[data-act="' + a + '"]');
      if (b) b.remove();
    });
    fitPanelWindow();
    addEventListener('resize', fitPanelWindow);
  } else {
    const dockBtn = shadow.querySelector('[data-act="dock"]');
    if (dockBtn) dockBtn.remove();          // only the standalone window can dock
    makeDraggable(shadow.querySelector('.bar'));
    shadow.querySelectorAll('.rs').forEach(h => makeResizable(h, h.dataset.rs));
    makeResizable(shadow.querySelector('.grip'), 's');
    restoreGeometry();
    wireDropZone();
  }
  paintAlignBtn();
  paintStatus();
}

/* Standalone window: fill it, and split the height between the lanes. */
function fitPanelWindow() {
  if (!shadow) return;
  panelW = innerWidth;
  const avail = Math.max(120, innerHeight - 34 - 40 - 26);
  // Past four lanes, stop shrinking and let the lane area scroll instead: thinner
  // strips stop being readable long before they stop fitting.
  const n = Math.max(1, Math.min(4, lanes.size));
  laneH = Math.max(56, Math.min(420, Math.floor(avail / n) - 34));
  shadow.querySelectorAll('canvas').forEach(c => { c.style.height = laneH + 'px'; });
  refreshAll();
}

/* ============================ settings ============================ */
function loadSettings() {
  try {
    return api.storage.local.get('settings').then(({ settings }) => {
      cfg = Object.assign({}, DEFAULTS, settings || {});
      // v1 capped at 4 by default, which parked everything past the fourth clip
      // where nobody could see it. Anyone still sitting on that exact number was
      // never choosing it, so lift it; a deliberate 1-3 or 5-8 is left alone.
      if (settings && Number(settings.v) !== SETTINGS_V) {
        const from = Number(settings.v) || 1;
        // Only ever migrate a value that is exactly the old default: that is the
        // one nobody chose. A deliberate setting is left alone.
        if (from < 2 && Number(settings.maxLanes) === 4) cfg.maxLanes = 0;
        if (from < 3 && Number(settings.minDur) === 1) cfg.minDur = DEFAULTS.minDur;
        cfg.v = SETTINGS_V;
        saveSettings();
      }
      aligned = !!cfg.autoAlign;
      return cfg;
    }).catch(() => cfg);
  } catch (e) { return Promise.resolve(cfg); }
}

function saveSettings() {
  try { api.storage.local.set({ settings: cfg }); } catch (e) {}
}

function buildSettings(panel) {
  const mk = (tag, props) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'dataset') { for (const d in props.dataset) n.dataset[d] = props.dataset[d]; }
      else n[k] = props[k];
    }
    return n;
  };
  const sheet = mk('div', { className: 'sheet' });
  sheet.hidden = true;

  const head = mk('div', { className: 'sheetHead' });
  head.appendChild(mk('span', { textContent: 'Settings' }));
  const close = mk('button', { className: 'ico', textContent: '\u2715', title: 'Close' });
  close.addEventListener('click', () => { sheet.hidden = true; });
  head.appendChild(close);
  sheet.appendChild(head);

  const row = (label, control, hint) => {
    const r = mk('div', { className: 'row' });
    const l = mk('label', { className: 'rowLabel' });
    l.appendChild(mk('span', { textContent: label }));
    if (hint) l.appendChild(mk('small', { textContent: hint }));
    r.appendChild(l);
    r.appendChild(control);
    sheet.appendChild(r);
    return r;
  };

  const maxIn = mk('input', { type: 'number', className: 'num', min: '0', max: String(LANE_HARD_MAX), step: '1' });
  maxIn.value = String(cfg.maxLanes);
  maxIn.addEventListener('change', () => {
    const v = parseInt(maxIn.value, 10);
    cfg.maxLanes = isFinite(v) ? Math.max(0, Math.min(LANE_HARD_MAX, v)) : 0;
    maxIn.value = String(cfg.maxLanes);
    saveSettings();
    flushParked();
  });
  row('Max lanes', maxIn, '0 = no limit: every clip gets a lane and the list scrolls');

  const fullSel = mk('select', { className: 'pick' });
  [['keep', 'Keep what is shown'], ['replace', 'Replace the oldest']].forEach(([v, t]) => {
    const o = mk('option', { value: v, textContent: t });
    if (cfg.whenFull === v) o.selected = true;
    fullSel.appendChild(o);
  });
  fullSel.addEventListener('change', () => { cfg.whenFull = fullSel.value; saveSettings(); });
  row('When full', fullSel, 'New audio is never discarded silently');

  const minIn = mk('input', { type: 'number', className: 'num', min: String(MIN_DUR_LO),
                              max: String(MIN_DUR_HI), step: '0.1' });
  minIn.value = String(cfg.minDur);
  minIn.addEventListener('change', () => {
    const v = parseFloat(minIn.value);
    cfg.minDur = isFinite(v) ? Math.max(MIN_DUR_LO, Math.min(MIN_DUR_HI, v)) : DEFAULTS.minDur;
    minIn.value = String(cfg.minDur);
    saveSettings();
    applyMinDur();
  });
  row('Ignore clips shorter than', minIn,
      'Seconds, ' + MIN_DUR_LO + '\u2013' + MIN_DUR_HI + '. Keeps jingles and the silent primers players fire out of the way');

  const autoCb = mk('input', { type: 'checkbox' });
  autoCb.checked = !!cfg.autoAlign;
  autoCb.addEventListener('change', () => {
    cfg.autoAlign = autoCb.checked;
    saveSettings();
    aligned = cfg.autoAlign;
    applyAlign();
  });
  row('Align on arrival', autoCb, 'New audio comes in cropped and starting at zero, with no click');

  const syncCb = mk('input', { type: 'checkbox' });
  syncCb.checked = !!cfg.sync;
  syncCb.addEventListener('change', () => { cfg.sync = syncCb.checked; saveSettings(); refreshAll(); });
  row('Shared time scale', syncCb, 'Lanes line up vertically — keep this on to compare');

  const gainSel = mk('select', { className: 'pick' });
  [['auto', 'Auto'], ['1', '\u00d71'], ['2', '\u00d72'], ['4', '\u00d74'], ['8', '\u00d78']].forEach(([v, t]) => {
    const o = mk('option', { value: v, textContent: t });
    if (String(cfg.gain) === v) o.selected = true;
    gainSel.appendChild(o);
  });
  gainSel.addEventListener('change', () => {
    cfg.gain = gainSel.value === 'auto' ? 'auto' : Number(gainSel.value);
    saveSettings(); refreshAll();
  });
  row('Vertical zoom', gainSel, 'Same factor for every lane, so loudness stays comparable');

  const trimCb = mk('input', { type: 'checkbox' });
  trimCb.checked = !!cfg.trimOnAlign;
  trimCb.addEventListener('change', () => { cfg.trimOnAlign = trimCb.checked; saveSettings(); });
  row('Align crops silence', trimCb, 'Align removes the dead air at both ends');

  const thrSel = mk('select', { className: 'pick' });
  [['0.04', 'Gentle'], ['0.08', 'Normal'], ['0.15', 'Aggressive']].forEach(([v, t]) => {
    const o = mk('option', { value: v, textContent: t });
    if (String(cfg.trimThresh) === v) o.selected = true;
    thrSel.appendChild(o);
  });
  thrSel.addEventListener('change', () => { cfg.trimThresh = Number(thrSel.value); saveSettings(); });
  row('Crop strength', thrSel, 'How loud counts as "not silence"');

  const foot = mk('div', { className: 'foot' });
  foot.appendChild(document.createTextNode('Waveform Viewer' + (VERSION ? ' v' + VERSION : '') + ' \u00b7 '));
  foot.appendChild(mk('a', {
    textContent: 'github.com/EricZhou866/waveform-viewer',
    href: REPO_URL, target: '_blank', rel: 'noopener noreferrer'
  }));
  sheet.appendChild(foot);

  panel.appendChild(sheet);
  return sheet;
}

/* The cut-off changed: drop what no longer qualifies, and forget the sources
   rejected under the old one so a lower cut-off can let them back in. */
function applyMinDur() {
  rejected.clear();
  const m = minDur();
  for (const [k, l] of [...lanes.entries()]) {
    const d = l.duration || (l.el && l.el.duration) || 0;
    if (d && d < m) dropLane(k);
  }
  for (let i = parked.length - 1; i >= 0; i--) {
    const p = parked[i];
    const d = p.duration || (p.peaks && p.peaks.duration) || 0;
    if (d && d < m) parked.splice(i, 1);
  }
  flushParked();
  refreshAll();
}

function toggleSettings() {
  const sheet = shadow && shadow.querySelector('.sheet');
  if (sheet) sheet.hidden = !sheet.hidden;
}

function applyCursorMode() {
  if (!shadow) return;
  shadow.querySelectorAll('.wrap').forEach(w => w.classList.toggle('move', moveMode));
}

function paintStatus() {
  if (!statusEl) return;
  while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
  const put = (label, value) => {
    if (statusEl.childNodes.length) statusEl.appendChild(document.createTextNode(' \u00b7 '));
    statusEl.appendChild(document.createTextNode(label + ' '));
    const b = document.createElement('b');
    b.textContent = String(value);
    statusEl.appendChild(b);
  };
  if (parked.length > 0) {
    const w = document.createElement('b');
    w.textContent = String(parked.length);
    statusEl.appendChild(document.createTextNode('\u23f3 '));
    statusEl.appendChild(w);
    statusEl.appendChild(document.createTextNode(
      ' clip' + (parked.length > 1 ? 's' : '') + ' waiting \u2014 ' + lanes.size + '/' + laneCap() +
      ' lanes in use. ' + (Number(cfg.maxLanes) > 0
        ? 'Close a lane, or raise Max lanes in Settings.'
        : 'Close a lane to let the next one in.')));
    return;
  }
  if (IS_PANEL) {
    put('lanes', lanes.size);
    put('source', 'this window');
  } else {
    put('media elements', stat.media);
    put('decoded', stat.dec);
    put('audio requests', stat.url);
    put('page hook', stat.hook ? 'active' : 'blocked');
  }
  const empty = lanesBox.querySelector('.empty');
  if (!lanes.size && !empty) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No audio captured yet. Play something on this page, or hit Rescan.';
    lanesBox.appendChild(d);
  } else if (lanes.size && empty) empty.remove();
}

function applySize() {
  if (!shadow) return;
  if (!IS_PANEL) {
    shadow.querySelector('.panel').style.width = panelW + 'px';
    if (lanesBox) {
      lanesBox.style.maxHeight = panelH + 'px';
      lanesBox.style.height = panelHSet ? panelH + 'px' : '';
    }
  }
  shadow.querySelectorAll('canvas').forEach(c => { c.style.height = laneH + 'px'; });
  refreshAll();
  saveGeometry();
}

function updateCount() {
  if (!shadow) return;
  shadow.querySelector('.count').textContent = lanes.size ? `· ${lanes.size} ${lanes.size > 1 ? 'lanes' : 'lane'}` : '';
}

function recomputeGain() {
  let peak = 0;
  for (const l of lanes.values()) if (l.peaks)
    for (let i = 0; i < l.peaks.maxs.length; i++) {
      const v = Math.max(l.peaks.maxs[i], -l.peaks.mins[i]);
      if (v > peak) peak = v;
    }
  gainVal = cfg.gain === 'auto'
    ? Math.max(1, Math.min(12, peak > 0.001 ? 0.94 / peak : 1))
    : Number(cfg.gain) || 1;
}

function refreshAll() {
  recomputeGain();
  for (const l of lanes.values()) { redraw(l); paintCursor(l); paintOffset(l); paintMeta(l); }
  updateCount();
  paintStatus();
  applyCursorMode();
}

function relayout() { if (IS_PANEL) fitPanelWindow(); }

/* ============ the standalone panel window ============
 * The old approach moved the panel's DOM into a window.open() popup. That
 * depends on cross-window DOM adoption, which is not portable — it fails on
 * Firefox. Instead the background opens a real extension page (panel.html)
 * running this same file in IS_PANEL mode, and the lanes are handed over as
 * descriptors. The window is independent of the tab, so it also survives
 * navigating away.
 */
/* Bytes for a lane, for handing over to the panel window.
   Preference order:
     1. the original file, if we still hold it and it can be read here
     2. a WAV re-encoded from the AudioBuffer we decoded ourselves — that memory
        is always local, so it works even when (1) is blocked
   Never throws; returns null when there is nothing to send. */
const XFER_MAX = 12 * 1024 * 1024;

function laneBytes(l) {
  if (l.raw && l.raw.byteLength <= XFER_MAX) {
    const b64 = bufToB64(l.raw);
    if (b64) return { b64, mime: l.mime || '' };
  }
  if (l.buffer) {
    try {
      const a = l.trimA || 0;
      const b = l.trimB == null ? l.duration : l.trimB;
      const ab = encodeWavBuffer(l.buffer, a, b, true);   // mono keeps it small
      if (ab.byteLength <= XFER_MAX) {
        const b64 = bufToB64(ab);
        if (b64) return { b64, mime: 'audio/wav' };
      }
    } catch (e) {}
  }
  return null;
}

function laneDescriptor(l) {
  const d = {
    url: l.url || '',
    label: (l.nameEl && l.nameEl.textContent) || 'audio',
    offset: l.offset || 0,
    muted: !!l.muted
  };
  // A blob:/data: URL belongs to the page and cannot be fetched from an
  // extension page, and a lane opened from disk has no URL at all. Both have to
  // travel as bytes.
  const refetchable = /^https?:/i.test(d.url);
  if (!refetchable) {
    const bytes = laneBytes(l);
    if (bytes) { d.b64 = bytes.b64; d.mime = bytes.mime; }
    else d.unavailable = true;
  }
  return d;
}

/* Rebuild each descriptor from primitives only. Anything that cannot be turned
   into a plain value is dropped rather than allowed to break the message. */
function plainDescriptors() {
  const out = [];
  for (const l of lanes.values()) {
    if (!l.peaks) continue;
    let d = null;
    try { d = laneDescriptor(l); } catch (e) { d = null; }
    if (!d) continue;
    const p = {
      url: String(d.url || ''),
      label: String(d.label || 'audio'),
      offset: Number(d.offset) || 0,
      muted: !!d.muted
    };
    if (typeof d.b64 === 'string' && d.b64) { p.b64 = d.b64; p.mime = String(d.mime || ''); }
    else if (!/^https?:/i.test(p.url)) p.unavailable = true;
    out.push(p);
  }
  return out;
}

async function popOut() {
  let lanesPayload = [];
  try { lanesPayload = plainDescriptors(); } catch (e) { lanesPayload = []; }
  try {
    const r = await api.runtime.sendMessage({ type: 'wf:openPanel', lanes: lanesPayload });
    // The window opening is what matters; a payload problem is reported softly.
    if (r && r.ok === false) note('Could not open the window: ' + (r.error || 'unknown'));
    else if (r && r.partial) note('Window opened, but the audio could not be handed over.');
  } catch (e) {
    // Ask for the window with no payload at all rather than giving up.
    try {
      const r2 = await api.runtime.sendMessage({ type: 'wf:openPanel', lanes: [] });
      if (!r2 || r2.ok === false) note('Could not open the window: ' + ((e && e.message) || e));
      else note('Window opened empty \u2014 use \u2295 Files there, or replay the audio.');
    } catch (e2) {
      note('Could not open the window: ' + ((e && e.message) || e));
    }
  }
}

/* The way back: the standalone window hands control to the in-page panel again.
 * The background owns the window, so it closes it and tells the tab to show its
 * panel — window.close() on its own would leave that bookkeeping untouched and
 * the page would keep hiding its panel. Still used as a fallback. */
async function dockBack() {
  try {
    const r = await api.runtime.sendMessage({ type: 'wf:dockPanel' });
    if (r && r.ok) return;
  } catch (e) {}
  try { window.close(); } catch (e) {}
}

/* Keep an open panel window in step with what the tab discovers. */
function broadcastLane(lane) {
  if (IS_PANEL || !lane.peaks) return;
  try {
    const d = plainDescriptors().find(x => x.label === lane.nameEl.textContent);
    if (d) api.runtime.sendMessage({ type: 'wf:panelLane', lane: d });
  } catch (e) {}
}

/* Show a short message on the status bar without touching innerHTML. */
function note(text) {
  if (!statusEl) return;
  while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
  statusEl.appendChild(document.createTextNode('\u26a0 ' + text));
  setTimeout(paintStatus, 6000);
}

/* ============ opening audio files from disk ============ */
function pickFiles() {
  const doc = (host && host.ownerDocument) || document;
  const inp = doc.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*,video/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac,.webm';
  inp.multiple = true;
  inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
  doc.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    const files = [...(inp.files || [])];
    inp.remove();
    for (const f of files) await addFile(f);
  });
  inp.click();
}

async function addFile(file) {
  const key = 'file:' + file.name + ':' + file.size + ':' + (file.lastModified || 0);
  if (lanes.has(key)) return;
  try {
    const buf = await file.arrayBuffer();
    await addBytes(key, file.name, buf, file.type || guessMime(file.name));
  } catch (e) {
    note('Could not read ' + file.name + ': ' + ((e && e.message) || e));
  }
}

/* Shared by the file picker and by lanes handed to the panel window as bytes. */
async function addBytes(key, label, buf, mime) {
  let audio;
  try { audio = await actx().decodeAudioData(buf.slice(0)); }
  catch (e) { note('Cannot decode ' + label + ' — unsupported codec'); return; }
  if (!audio || audio.duration < minDur()) {
    note(label + ' is shorter than the ' + minDur() + 's minimum (' +
         (audio ? audio.duration.toFixed(2) : '0') + 's) \u2014 change it in Settings');
    return;
  }
  const peaks = computePeaks(audio);
  offer({
    key, url: '', label, peaks, duration: peaks.duration,
    buffer: audio, raw: buf, mime: mime || ''
  });
}

/* Drag audio files straight onto the panel. */
function wireDropZone() {
  if (!host) return;
  const doc = host.ownerDocument;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const target = IS_PANEL ? doc.body : host;
  target.addEventListener('dragover', (e) => { stop(e); e.dataTransfer.dropEffect = 'copy'; });
  target.addEventListener('drop', async (e) => {
    stop(e);
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    for (const f of files) await addFile(f);
  });
}


/* dragging / resizing / persisted geometry */
function makeDraggable(handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.target.dataset && e.target.dataset.act) return;
    const r = pinHost();
    const sx = e.clientX, sy = e.clientY, sl = r.left, st = r.top;
    const mv = (ev) => {
      host.style.setProperty('left', Math.max(0, Math.min(winOf().innerWidth - 80, sl + ev.clientX - sx)) + 'px', 'important');
      host.style.setProperty('top', Math.max(0, Math.min(winOf().innerHeight - 30, st + ev.clientY - sy)) + 'px', 'important');
    };
    const up = () => { winOf().removeEventListener('mousemove', mv); winOf().removeEventListener('mouseup', up); saveGeometry(); };
    winOf().addEventListener('mousemove', mv); winOf().addEventListener('mouseup', up);
    e.preventDefault();
  });
}

/* Resizing sizes the panel, not the waveforms: lane height has its own control
   (＋/－), so a drag changes how much of the stack is on screen at once, and past
   that the lane area scrolls.
   `dir` is any combination of n/s/e/w. Dragging the north or west side has to move
   the panel as well as resize it, so the opposite edge stays where it is —
   otherwise the panel slides out from under the cursor. */
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
                 nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
const clampN = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

function makeResizable(el, dir) {
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = pinHost();
    const sx = e.clientX, sy = e.clientY, sw = panelW, sh = panelH;
    const panelEl = shadow.querySelector('.panel');
    const doc = winOf().document;
    const prevCursor = doc.body.style.cursor;
    // Hold the cursor for the whole drag: once the pointer leaves the 5px strip
    // it would otherwise flip back to whatever it is over.
    doc.body.style.cursor = CURSOR[dir] || 'default';

    const mv = (ev) => {
      const vh = winOf().innerHeight || 900;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (dir.indexOf('e') >= 0) panelW = clampN(340, 1500, sw + dx);
      if (dir.indexOf('w') >= 0) panelW = clampN(340, 1500, sw - dx);
      const hiH = Math.max(160, vh - 140);
      if (dir.indexOf('s') >= 0) { panelH = clampN(120, hiH, sh + dy); panelHSet = true; }
      if (dir.indexOf('n') >= 0) { panelH = clampN(120, hiH, sh - dy); panelHSet = true; }
      applySize();
      // Hold the opposite edge by measuring what the panel actually became, not
      // by assuming it grew by exactly what was asked for: it is clamped at both
      // ends, and until panelHSet it could refuse to grow at all.
      const now = panelEl.getBoundingClientRect();
      if (dir.indexOf('w') >= 0) host.style.setProperty('left', (r.right - now.width) + 'px', 'important');
      if (dir.indexOf('n') >= 0) host.style.setProperty('top', (r.bottom - now.height) + 'px', 'important');
    };
    const up = () => {
      winOf().removeEventListener('mousemove', mv);
      winOf().removeEventListener('mouseup', up);
      doc.body.style.cursor = prevCursor;
      saveGeometry();
    };
    winOf().addEventListener('mousemove', mv);
    winOf().addEventListener('mouseup', up);
    e.preventDefault();
    e.stopPropagation();
  });
}

/* Anchor the panel by left/top. It starts pinned to the right and bottom edges,
   which is what keeps it in the corner as the page window changes size — but an
   edge drag has to move it, and that needs coordinates it can write to. */
function pinHost() {
  const r = host.getBoundingClientRect();
  host.style.setProperty('left', r.left + 'px', 'important');
  host.style.setProperty('top', r.top + 'px', 'important');
  host.style.setProperty('right', 'auto', 'important');
  host.style.setProperty('bottom', 'auto', 'important');
  return r;
}

function saveGeometry() {
  if (IS_PANEL) return;
  try {
    const r = host.getBoundingClientRect();
    api.storage.local.set({ geom: { left: r.left, top: r.top, w: panelW, h: laneH, ph: panelH, hset: panelHSet } });
  } catch (e) {}
}

function restoreGeometry() {
  try {
    api.storage.local.get('geom').then(({ geom }) => {
      if (!geom) return;
      panelW = geom.w || panelW; laneH = geom.h || laneH; panelH = geom.ph || panelH;
      panelHSet = !!geom.hset;
      if (geom.left != null && geom.left < winOf().innerWidth - 60 && geom.top < winOf().innerHeight - 40) {
        host.style.setProperty('left', geom.left + 'px', 'important');
        host.style.setProperty('top', geom.top + 'px', 'important');
        host.style.setProperty('right', 'auto', 'important');
        host.style.setProperty('bottom', 'auto', 'important');
      }
      applySize();
    }).catch(() => {});
  } catch (e) {}
}

/* ============================ lanes ============================ */
const pending = [];
function createLane(spec) {
  ensurePanel();
  if (!lanesBox) {
    if (!pending.some(p => p.key === spec.key)) pending.push(spec);
    addEventListener('DOMContentLoaded', () => pending.splice(0).forEach(offer), { once: true });
    return;
  }
  if (lanes.size >= laneCap()) {
    if (cfg.whenFull === 'replace') {
      const victim = [...lanes.entries()].find(([, l]) => !l.pinned);
      if (victim) dropLane(victim[0]);
      else { park(spec); return; }
    } else {
      park(spec);   // never drop what the user is looking at
      return;
    }
  }

  const node = document.createElement('div');
  node.className = 'lane';
  node.innerHTML = `
    <div class="head">
      <button class="ico" data-a="pin" title="Pin this lane (never auto-evicted)">☆</button>
      <span class="name"></span>
      <span class="off" title="Time offset — click to reset"></span>
      <span class="sel"></span>
      <span class="meta"></span>
      <button class="ico" data-a="save" title="Download — selection as WAV, or the whole file">⬇</button>
      <button class="ico" data-a="solo" title="Solo — mute every other lane">◉</button>
      <button class="ico" data-a="mute" title="Mute this lane">🔊</button>
      <button class="ico" data-a="close" title="Remove this lane">✕</button>
    </div>
    <div class="wrap">
      <canvas></canvas>
      <div class="region"></div>
      <div class="cursor"></div>
    </div>`;
  lanesBox.appendChild(node);

  const lane = {
    key: spec.key, url: spec.url || '', el: spec.el || null, node,
    canvas: node.querySelector('canvas'),
    nameEl: node.querySelector('.name'),
    metaEl: node.querySelector('.meta'),
    selEl: node.querySelector('.sel'),
    offEl: node.querySelector('.off'),
    curEl: node.querySelector('.cursor'),
    regEl: node.querySelector('.region'),
    wrap: node.querySelector('.wrap'),
    peaks: spec.peaks || null,
    sig: null,
    buffer: spec.buffer || null,
    duration: spec.duration || (spec.peaks && spec.peaks.duration) || 0,
    offset: spec.offset || 0, muted: !!spec.muted, pinned: false, raf: 0,
    trimA: 0, trimB: null,
    raw: spec.raw || null, mime: spec.mime || '', selA: null, selB: null
  };
  lanes.set(lane.key, lane);

  lane.canvas.style.height = laneH + 'px';
  lane.nameEl.textContent = spec.label || 'audio';
  lane.nameEl.title = lane.url || spec.label || '';
  lane.metaEl.textContent = lane.peaks ? fmtSec(lane.duration) : 'analyzing…';

  node.querySelector('.head').addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (a === 'close') { dropLane(lane.key); return; }
    if (a === 'pin') {
      lane.pinned = !lane.pinned;
      e.target.textContent = lane.pinned ? '★' : '☆';
      e.target.classList.toggle('on', lane.pinned);
    }
    if (a === 'save') download(lane);
    if (a === 'mute') setMute(lane, !lane.muted);
    if (a === 'solo') {
      const others = [...lanes.values()].filter(l => l !== lane);
      const alreadySolo = others.every(l => l.muted) && !lane.muted;
      others.forEach(l => setMute(l, !alreadySolo));
      setMute(lane, false);
    }
  });

  lane.offEl.addEventListener('click', () => { lane.offset = 0; refreshAll(); });

  if (lane.peaks) joinAlign(lane);
  if (lane.el) wireMedia(lane);
  wireMouse(lane);

  if (lane.muted) setMute(lane, true);
  if (lane.peaks && dedupe(lane)) return;

  // A URL lane still fetches the real file: full-resolution peaks plus a
  // buffer we can play. Lanes that arrived as bytes already have both.
  if (lane.url) loadPeaks(lane);

  refreshAll();
  relayout();
  broadcastLane(lane);
}

function setMute(lane, on) {
  lane.muted = on;
  lane.node.classList.toggle('muted', on);
  const b = lane.node.querySelector('[data-a="mute"]');
  b.textContent = on ? '🔇' : '🔊';
  b.classList.toggle('off2', on);
  redraw(lane);
  if (T.playing) playAll(T.pos);      // apply immediately
}

function park(spec) {
  if (!parked.some(p => p.key === spec.key)) {
    parked.push(spec);
    while (parked.length > PARK_MAX) parked.shift();
  }
  paintStatus();
}

/* Let waiting clips in as soon as there is room. */
function flushParked() {
  while (parked.length && lanes.size < laneCap()) {
    const spec = parked.shift();
    if (!lanes.has(spec.key)) createLane(spec);
  }
  paintStatus();
}

function dropLane(key) {
  const lane = lanes.get(key);
  if (!lane) return;
  winOf().cancelAnimationFrame(lane.raf);
  lane.detach && lane.detach();
  lane.node.remove();
  lanes.delete(key);
  refreshAll();
  relayout();
  flushParked();
}

function wireMedia(lane) {
  const el = lane.el;
  if (!el || lane.detach) return;
  const onPlay = () => { lane.nameEl.classList.add('playing'); tickEl(lane); };
  const onStop = () => { lane.nameEl.classList.remove('playing'); winOf().cancelAnimationFrame(lane.raf); paintCursor(lane); };
  const onSeek = () => paintCursor(lane);
  el.addEventListener('play', onPlay); el.addEventListener('pause', onStop);
  el.addEventListener('ended', onStop); el.addEventListener('seeked', onSeek);
  el.addEventListener('timeupdate', onSeek);
  lane.detach = () => {
    el.removeEventListener('play', onPlay); el.removeEventListener('pause', onStop);
    el.removeEventListener('ended', onStop); el.removeEventListener('seeked', onSeek);
    el.removeEventListener('timeupdate', onSeek);
  };
  if (!el.paused) onPlay();
}

function tickEl(lane) {
  paintCursor(lane);
  if (lane.el && !lane.el.paused && !T.playing) lane.raf = winOf().requestAnimationFrame(() => tickEl(lane));
}

function paintMeta(lane) {
  if (!lane.peaks) return;
  const v = visDur(lane);
  lane.metaEl.textContent = lane.trimB != null
    ? fmtSec(v) + ' \u2702'          // scissors: this lane is cropped
    : fmtSec(v);
  lane.metaEl.title = lane.trimB != null
    ? 'Cropped from ' + fmtSec(lane.duration) + ' \u2014 click Align again to restore'
    : '';
}

function paintOffset(lane) {
  lane.offEl.textContent = Math.abs(lane.offset) < 0.001 ? ''
    : (lane.offset > 0 ? '+' : '') + lane.offset.toFixed(3) + 's';
}

function paintCursor(lane) {
  const { t0, span } = laneAxis(lane);
  const W = lane.wrap.clientWidth;
  // While the page plays its own element, follow that; otherwise follow our
  // transport, which sits at 0 after a rewind so the playhead parks at the start.
  let t;
  if (T.playing) t = T.pos;
  else if (lane.el && !lane.el.paused && lane.el.currentTime > 0) t = lane.offset + lane.el.currentTime;
  else t = T.pos || 0;
  if (!span) { lane.curEl.style.display = 'none'; return; }
  const x = (t - t0) / span * W;
  if (x < -2 || x > W + 2) { lane.curEl.style.display = 'none'; return; }
  lane.curEl.style.display = 'block';
  lane.curEl.style.left = x + 'px';
}

/* Mouse on the waveform: drag to shift, drag to select, click to seek */
function wireMouse(lane) {
  const xToTime = (clientX) => {
    const r = lane.wrap.getBoundingClientRect();
    const { t0, span } = laneAxis(lane);
    return t0 + (clientX - r.left) / r.width * span;
  };

  lane.wrap.addEventListener('mousedown', (e) => {
    const r = lane.wrap.getBoundingClientRect();
    const x0 = e.clientX;
    const isMove = moveMode !== e.shiftKey;      // Shift temporarily flips between move and select
    const startOffset = lane.offset;
    const { span } = laneAxis(lane);
    let moved = false;

    const mv = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) < 3) return;
      moved = true;
      if (isMove) {
        lane.offset = startOffset + dx / r.width * span;
        paintOffset(lane);
        for (const l of lanes.values()) { redraw(l); paintCursor(l); }
      } else {
        const a = Math.max(0, Math.min(x0, ev.clientX) - r.left);
        const b = Math.min(r.width, Math.max(x0, ev.clientX) - r.left);
        lane.regEl.style.display = 'block';
        lane.regEl.style.left = a + 'px';
        lane.regEl.style.width = Math.max(0, b - a) + 'px';
        const ta = xToTime(x0), tb = xToTime(ev.clientX);
        lane.selA = Math.min(ta, tb) - lane.offset;
        lane.selB = Math.max(ta, tb) - lane.offset;
        lane.selEl.textContent = 'sel ' + Math.abs(tb - ta).toFixed(3) + 's';
      }
    };
    const up = () => {
      winOf().removeEventListener('mousemove', mv); winOf().removeEventListener('mouseup', up);
      if (!moved) {
        lane.regEl.style.display = 'none'; lane.selEl.textContent = '';
        lane.selA = lane.selB = null;
        const t = xToTime(x0);
        T.pos = t;
        if (T.playing) playAll(t); else paintAllCursors();
      } else if (isMove) refreshAll();
    };
    winOf().addEventListener('mousemove', mv); winOf().addEventListener('mouseup', up);
    e.preventDefault();
  });

  lane.wrap.addEventListener('dblclick', () => {
    lane.regEl.style.display = 'none'; lane.selEl.textContent = '';
    lane.selA = lane.selB = null;
  });
}

/* ================== download → decode → peaks ================== */
async function loadPeaks(lane) {
  const url = lane.url;
  const cached = peakCache.get(url);
  if (cached) {
    lane.peaks = cached.peaks; lane.buffer = cached.buffer; lane.duration = cached.peaks.duration;
    lane.raw = cached.raw || null; lane.mime = cached.mime || '';
    lane.metaEl.textContent = fmtSec(lane.duration);
    if (dedupe(lane)) return;
    refreshAll(); return;
  }

  let buf = null, err = null;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) buf = await res.arrayBuffer(); else err = 'HTTP ' + res.status;
  } catch (e) { err = String(e && e.message || e); }

  if (!buf && !url.startsWith('blob:') && !url.startsWith('data:')) {
    try {
      const r = await api.runtime.sendMessage({ type: 'wf:fetch', url });
      if (r && r.b64) { buf = b64ToBuf(r.b64); err = null; }
      else if (r && r.error) err = r.error;
    } catch (e) { err = String(e && e.message || e); }
  }
  if (!buf) {
    rejected.add(url);                 // do not retry this source every playback
    if (!lane.peaks) fail(lane, err || 'Could not read the audio data');
    return;
  }

  let audio;
  try { audio = await actx().decodeAudioData(buf.slice(0)); }
  catch (e) {
    rejected.add(url);
    if (!lane.peaks) {
      note('Cannot decode ' + (lane.nameEl.textContent || 'audio') + ' \u2014 unsupported codec');
      dropLane(lane.key);
    }
    return;
  }

  // Too short to be real content (silent primers decode to a few milliseconds).
  // Remember the source so we do not keep fetching and decoding it.
  if (!audio || audio.duration < minDur()) {
    rejected.add(url);
    dropLane(lane.key);
    return;
  }

  if (buf.byteLength <= 25 * 1024 * 1024) { lane.raw = buf; lane.mime = guessMime(url); }
  const peaks = computePeaks(audio);
  peakCache.set(url, { peaks, buffer: audio, raw: lane.raw, mime: lane.mime });
  if (peakCache.size > 12) peakCache.delete(peakCache.keys().next().value);
  lane.peaks = peaks; lane.buffer = audio; lane.duration = peaks.duration;
  lane.metaEl.textContent = fmtSec(peaks.duration);
  if (dedupe(lane)) return;
  joinAlign(lane);
  refreshAll();
  broadcastLane(lane);
}

function fail(lane, msg) {
  lane.metaEl.textContent = '';
  lane.wrap.style.display = 'none';
  if (!lane.node.querySelector('.msg')) {
    const p = document.createElement('div');
    p.className = 'msg'; p.textContent = '⚠ ' + msg;
    lane.node.appendChild(p);
  }
}

/* Sites often mint a fresh blob: URL every time they play the same clip, so the
   URL is not a usable identity. Fingerprint the decoded audio instead.

   The two detection routes hand us peaks at different resolutions (the page-world
   hook sends 2048 buckets, our own decode computes 8192), so the fingerprint has
   to be resolution-independent: duration plus a coarse 32-bucket loudness shape,
   each bucket quantised to four levels relative to the clip's own peak. Verified
   to match across 512 / 2048 / 8192 buckets for the same audio. */
function sigOf(peaks) {
  const B = 32;
  const a = peaks.maxs, b = peaks.mins, n = a.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, a[i], -b[i]);
  if (peak < 1e-6) peak = 1;
  let h = 2166136261;
  for (let k = 0; k < B; k++) {
    const s0 = Math.floor(k * n / B);
    const e0 = Math.max(s0 + 1, Math.floor((k + 1) * n / B));
    let m = 0;
    for (let i = s0; i < e0 && i < n; i++) m = Math.max(m, a[i], -b[i]);
    const r = m / peak;
    h ^= (r < 0.08 ? 0 : r < 0.35 ? 1 : r < 0.7 ? 2 : 3);
    h = Math.imul(h, 16777619);
  }
  return (peaks.duration || 0).toFixed(2) + ':' + (h >>> 0).toString(36);
}

/* Returns true when this lane duplicates one we already have (and removes it). */
function dedupe(lane) {
  if (!lane.peaks) return false;
  lane.sig = sigOf(lane.peaks);
  for (const other of lanes.values()) {
    if (other === lane || !other.sig || other.sig !== lane.sig) continue;
    // Keep whichever arrived first, but carry over anything it is missing.
    if (!other.buffer && lane.buffer) other.buffer = lane.buffer;
    if (!other.raw && lane.raw) { other.raw = lane.raw; other.mime = lane.mime; }
    if ((!other.peaks || other.peaks.mins.length < lane.peaks.mins.length)) {
      other.peaks = lane.peaks;
      other.duration = lane.duration;
      other.metaEl.textContent = fmtSec(lane.duration);
      redraw(other);
    }
    dropLane(lane.key);
    return true;
  }
  return false;
}

function computePeaks(audio) {
  const ch = audio.numberOfChannels, n = audio.length;
  const N = Math.min(PEAK_RES, Math.max(256, n));
  const mins = new Float32Array(N), maxs = new Float32Array(N);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(audio.getChannelData(c));
  const step = n / N;
  for (let i = 0; i < N; i++) {
    const s = Math.floor(i * step);
    const e = Math.max(s + 1, Math.min(n, Math.floor((i + 1) * step)));
    let mn = 0, mx = 0;
    for (let j = s; j < e; j++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += data[c][j];
      v /= ch;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    mins[i] = mn; maxs[i] = mx;
  }
  return { mins, maxs, duration: audio.duration };
}

/* ============================ download ============================ */
const MIMES = { mp3:'audio/mpeg', m4a:'audio/mp4', mp4:'audio/mp4', aac:'audio/aac',
  wav:'audio/wav', ogg:'audio/ogg', oga:'audio/ogg', opus:'audio/ogg',
  flac:'audio/flac', webm:'audio/webm', weba:'audio/webm' };

function extOf(url) {
  try { const p = new URL(url, location.href).pathname; const m = /\.([a-z0-9]{2,5})$/i.exec(p); return m ? m[1].toLowerCase() : ''; }
  catch (e) { const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url || ''); return m ? m[1].toLowerCase() : ''; }
}
function guessMime(url) { return MIMES[extOf(url)] || 'application/octet-stream'; }

function safeName(s) {
  return (s || 'audio').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* 16-bit PCM WAV encoder — used for selections and for buffers we have no original file for */
function encodeWav(buffer, startSec, endSec, mono) {
  return new Blob([encodeWavBuffer(buffer, startSec, endSec, mono)], { type: 'audio/wav' });
}

/* Always allocates its own ArrayBuffer, so the result is safe to base64 and
   pass across contexts on any engine. */
function encodeWavBuffer(buffer, startSec, endSec, mono) {
  const sr = buffer.sampleRate;
  const ch = mono ? 1 : Math.min(2, buffer.numberOfChannels);
  const s0 = Math.max(0, Math.floor((startSec || 0) * sr));
  const s1 = Math.min(buffer.length, Math.ceil((endSec == null ? buffer.duration : endSec) * sr));
  const n = Math.max(0, s1 - s0);
  const total = 44 + n * ch * 2;
  const ab = new ArrayBuffer(total);
  const v = new DataView(ab);
  const tag = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, total - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = s0; i < s1; i++) {
    for (let c = 0; c < ch; c++) {
      let x = chans[c][i];
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return ab;
}

function saveBlob(blob, filename) {
  const doc = (host && host.ownerDocument) || document;
  const w = winOf();
  const url = w.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = filename;
  a.style.cssText = 'position:fixed;left:-9999px;top:0';
  doc.body.appendChild(a);
  a.click();
  setTimeout(() => { try { a.remove(); w.URL.revokeObjectURL(url); } catch (e) {} }, 5000);
}

function flash(lane, text) {
  lane.selEl.textContent = text;
  setTimeout(() => { if (lane.selEl.textContent === text) lane.selEl.textContent = ''; }, 2200);
}

/* Selection → WAV. No selection → the original file if we still have its bytes,
   otherwise the whole decoded buffer as WAV. */
function download(lane) {
  const base = safeName((lane.nameEl.textContent || 'audio').replace(/\.[a-z0-9]{2,5}$/i, ''));
  const hasSel = lane.selA != null && lane.selB != null && (lane.selB - lane.selA) > 0.01;

  const t0 = lane.trimA || 0;

  if (hasSel) {
    if (!lane.buffer) { flash(lane, 'no audio data'); return; }
    // Selection times are in the visible timeline; shift them back into the file.
    const a = Math.max(0, t0 + lane.selA);
    const b = Math.min(lane.duration, t0 + lane.selB);
    saveBlob(encodeWav(lane.buffer, a, b),
             `${base}_${a.toFixed(2)}-${b.toFixed(2)}s.wav`);
    flash(lane, 'saved ' + (b - a).toFixed(2) + 's');
    return;
  }
  // Cropped lane, no selection: save exactly what is on screen.
  if (lane.trimB != null && lane.buffer) {
    saveBlob(encodeWav(lane.buffer, t0, lane.trimB), `${base}_trimmed.wav`);
    flash(lane, 'saved ' + visDur(lane).toFixed(2) + 's');
    return;
  }
  if (lane.raw) {
    const ext = extOf(lane.url) || 'mp3';
    saveBlob(new Blob([lane.raw], { type: lane.mime || 'application/octet-stream' }), `${base}.${ext}`);
    flash(lane, 'saved');
    return;
  }
  if (lane.buffer) {
    saveBlob(encodeWav(lane.buffer, 0, lane.duration), `${base}.wav`);
    flash(lane, 'saved wav');
    return;
  }
  flash(lane, 'nothing to save');
}

/* ============================ rendering ============================ */
function redraw(lane) {
  if (!lane.peaks) return;
  const cv = lane.canvas;
  const cssW = cv.clientWidth || panelW - 18;
  const cssH = laneH;
  const dpr = winOf().devicePixelRatio || 1;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const RULER = 14, waveH = cssH - RULER, mid = waveH / 2;
  const { t0, span } = laneAxis(lane);
  const shown = visDur(lane);
  const startT = cfg.sync ? lane.offset : 0;
  const xa = Math.round((startT - t0) / span * cssW);
  const xb = Math.round((startT + shown - t0) / span * cssW);
  const L = Math.max(0, xa), R = Math.min(cssW, xb);

  g.fillStyle = COLOR.dead; g.fillRect(0, 0, cssW, waveH);
  g.fillStyle = lane.muted ? COLOR.fieldMute : COLOR.field;
  g.fillRect(L, 0, Math.max(0, R - L), waveH);

  // Peaks cover the whole clip; only the kept region is drawn.
  const { mins, maxs } = lane.peaks, N = mins.length;
  const full = lane.duration || shown;
  const iA = lane.trimB == null ? 0 : Math.floor((lane.trimA / full) * N);
  const iB = lane.trimB == null ? N : Math.min(N, Math.ceil((lane.trimB / full) * N));
  const iN = Math.max(1, iB - iA);
  const W = Math.max(1, xb - xa);

  g.fillStyle = lane.muted ? COLOR.waveMute : COLOR.wave;
  for (let x = L; x < R; x++) {
    const u = x - xa;
    const a = iA + Math.floor(u * iN / W);
    const b = Math.max(a + 1, iA + Math.floor((u + 1) * iN / W));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i < N; i++) {
      if (mins[i] < mn) mn = mins[i];
      if (maxs[i] > mx) mx = maxs[i];
    }
    const y1 = Math.max(0, mid - mx * mid * gainVal);
    const y2 = Math.min(waveH, mid - mn * mid * gainVal);
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  g.fillStyle = COLOR.zero; g.fillRect(L, Math.round(mid), Math.max(0, R - L), 1);
  g.fillStyle = COLOR.ruler; g.fillRect(0, waveH, cssW, RULER);
  drawRuler(g, cssW, waveH, RULER, t0, span);
}

function drawRuler(g, w, top, h, t0, span) {
  if (!span || !isFinite(span)) return;
  const cands = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let major = cands[cands.length - 1];
  for (const c of cands) if (c / span * w >= 58) { major = c; break; }
  const minor = major / 5;
  g.font = '9px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'middle';
  const first = Math.ceil(t0 / minor) * minor;
  for (let t = first; t <= t0 + span + 1e-9; t += minor) {
    const x = Math.round((t - t0) / span * w) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.fillStyle = isMajor ? COLOR.tickHi : COLOR.tick;
    g.fillRect(x, top, 1, isMajor ? 6 : 3);
    if (isMajor && Math.abs(t) > 1e-9 && x < w - 22) {
      g.fillStyle = COLOR.label;
      g.fillText(major < 1 ? t.toFixed(2) : String(+t.toFixed(2)), x + 3, top + h / 2 + 1);
    }
  }
}

/* ============================ hotkeys ============================ */
function onHotkey(e) {
  if (!host || !lanes.size) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
  if (e.code === 'Space' && (e.ctrlKey || e.metaKey || IS_PANEL)) { e.preventDefault(); toggleAll(); }
}
addEventListener('keydown', onHotkey);

/* ============================ on/off ============================ */
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'wf:collectLanes' && !IS_PANEL) {
    return Promise.resolve({
      lanes: plainDescriptors()
    });
  }
  if (msg && msg.type === 'wf:panelOpen')   { setPanelVisible(false); return; }
  if (msg && msg.type === 'wf:panelClosed') { setPanelVisible(true);  return; }
  if (msg && msg.type === 'wf:enabled') {
    enabled = msg.enabled;
    if (!enabled) {
      stopAll();
      [...lanes.keys()].forEach(dropLane);
      if (host) { host.remove(); host = null; shadow = null; lanesBox = null; statusEl = null; }
    } else { ensurePanel(); scanDom(); }
  }
});

loadSettings().then(() => {
  if (IS_PANEL) { bootPanelWindow(); return; }
  try {
    api.runtime.sendMessage({ type: 'wf:getEnabled' })
      .then((r) => { enabled = !r || r.enabled !== false; if (enabled) boot(); })
      .catch(() => boot());
  } catch (e) { boot(); }
});

function boot() { scanDom(); [400, 1200, 3000].forEach(t => setTimeout(scanDom, t)); }

/* Panel window: no page to watch. Take the lanes handed over by the tab, then
   listen for anything it finds afterwards. Files can also be opened here. */
async function bootPanelWindow() {
  document.title = 'Waveform';
  ensurePanel();
  wireDropZone();
  let data = null;
  try { data = await api.runtime.sendMessage({ type: 'wf:getPanelData' }); } catch (e) {}
  for (const d of (data && data.lanes) || []) await adoptDescriptor(d);
  paintStatus();
}

async function adoptDescriptor(d) {
  if (!d) return;
  if (d.b64) {
    const buf = b64ToBuf(d.b64);
    const key = 'bytes:' + (d.label || 'audio') + ':' + buf.byteLength;
    if (lanes.has(key)) return;
    await addBytes(key, d.label || 'audio', buf, d.mime || '');
    const l = lanes.get(key);
    if (l) { l.offset = d.offset || 0; if (d.muted) setMute(l, true); refreshAll(); }
    return;
  }
  if (d.unavailable) return;   // page-only blob we could not capture bytes for
  if (d.url) {
    offer({ key: 'src:' + d.url, url: d.url, label: d.label || nameFromUrl(d.url),
            offset: d.offset || 0, muted: !!d.muted });
  }
}

api.runtime.onMessage.addListener((msg) => {
  if (IS_PANEL && msg && msg.type === 'wf:panelLaneFwd') adoptDescriptor(msg.lane);
});

/* Only one panel should ever be visible: when the standalone window is up, the
   in-page panel steps aside, and comes back when that window closes. */
function setPanelVisible(on) {
  if (IS_PANEL || !host) return;
  if (!on) stopAll();
  host.style.setProperty('display', on ? 'block' : 'none', 'important');
}

addEventListener('resize', () => refreshAll());
})();
