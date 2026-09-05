/* Waveform Viewer — content script */
(() => {
'use strict';
if (window.__wfViewerLoaded) return;
window.__wfViewerLoaded = true;

const api = (typeof browser !== 'undefined') ? browser : chrome;

const MAX_LANES = 4;
const PEAK_RES  = 8192;
const MIN_DUR   = 0.15;

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
let syncAxis = true, gainMode = 'auto', gainVal = 1;
let moveMode = false;
let popWin = null, popTimer = 0;
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
  if (u.startsWith('blob:')) return 'blob audio';
  if (u.startsWith('data:')) return 'data audio';
  try {
    const p = new URL(u, location.href);
    return decodeURIComponent((p.pathname.split('/').pop() || '').trim()) || p.hostname;
  } catch { return 'audio'; }
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
    if (!peaks.duration) return;
    const url = typeof d.url === 'string' ? d.url : '';
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
  if (el.duration && el.duration < MIN_DUR) return;
  offer({ key: 'src:' + url, url, label: nameFromUrl(url), el });
}

function offerUrl(url) {
  if (!enabled || !url) return;
  const key = 'src:' + url;
  if (!lanes.has(key)) stat.url++;
  offer({ key, url, label: nameFromUrl(url) });
}

function offer(spec) {
  if (!enabled) return;
  const ex = lanes.get(spec.key);
  if (ex) {
    let changed = false;
    if (spec.el && !ex.el) { ex.el = spec.el; wireMedia(ex); changed = true; }
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
function timeline() {
  let t0 = 0, t1 = 0.1;
  for (const l of lanes.values()) {
    if (!l.duration) continue;
    t0 = Math.min(t0, l.offset);
    t1 = Math.max(t1, l.offset + l.duration);
  }
  return { t0, t1, span: Math.max(0.1, t1 - t0) };
}

function laneAxis(lane) {
  if (syncAxis) { const g = timeline(); return { t0: g.t0, span: g.span }; }
  return { t0: 0, span: Math.max(0.1, lane.duration || 0.1) };
}

/* ======================= playback engine (Web Audio) ======================= */
function stopAll(keepPos) {
  T.sources.forEach(s => { try { s.stop(); } catch (e) {} });
  T.sources = [];
  T.playing = false;
  winOf().cancelAnimationFrame(T.raf);
  // T.pos is intentionally kept
  paintTransport();
  paintAllCursors();
}

function playAll(fromPos) {
  const ctx = actx();
  if (ctx.state === 'suspended') ctx.resume();
  stopAll(true);

  // Pause the page's own player so we don't hear two copies at once
  for (const l of lanes.values()) if (l.el && !l.el.paused) { try { l.el.pause(); } catch (e) {} }

  const g = timeline();
  let pos = fromPos != null ? fromPos : T.pos;
  if (!isFinite(pos) || pos < g.t0 || pos >= g.t1 - 0.02) pos = g.t0;

  const now = ctx.currentTime + 0.06;
  let any = false;
  for (const l of lanes.values()) {
    if (!l.buffer || l.muted) continue;
    const s = l.offset, e = l.offset + l.duration;
    if (pos >= e) continue;
    const src = ctx.createBufferSource();
    src.buffer = l.buffer;
    src.connect(ctx.destination);
    src.start(now + Math.max(0, s - pos), Math.max(0, pos - s));
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
  if (T.pos >= g.t1) { T.pos = g.t0; stopAll(); return; }
  paintAllCursors();
  T.raf = winOf().requestAnimationFrame(tickTransport);
}

function toggleAll() { T.playing ? stopAll() : playAll(); }

function paintTransport() {
  if (!shadow) return;
  const b = shadow.querySelector('[data-act="play"]');
  if (b) { b.textContent = T.playing ? '■ Stop' : '▶ Play'; b.classList.toggle('on', T.playing); }
}

function paintAllCursors() { for (const l of lanes.values()) paintCursor(l); }

/* Align onsets: shift every lane so its first audible moment lands at the same time */
function alignOnsets() {
  const info = [];
  for (const l of lanes.values()) {
    if (!l.peaks || !l.duration) continue;
    const { mins, maxs } = l.peaks, N = mins.length;
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, maxs[i], -mins[i]);
    const thr = peak * 0.12;
    let idx = 0;
    for (let i = 0; i < N; i++) {
      if (Math.max(maxs[i], -mins[i]) > thr) { idx = i; break; }
    }
    info.push({ lane: l, onset: idx / N * l.duration });
  }
  if (info.length < 1) return;
  const target = Math.max(...info.map(x => x.onset));
  info.forEach(x => { x.lane.offset = target - x.onset; });
  refreshAll();
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
  host.style.cssText = 'position:fixed!important;z-index:2147483600!important;' +
    'right:16px!important;bottom:16px!important;display:block!important;' +
    'width:auto!important;height:auto!important;margin:0!important;padding:0!important;';
  document.body.appendChild(host);

  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      * { box-sizing:border-box; margin:0; padding:0;
          font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
      .panel { width:${panelW}px; background:#1b1f28; color:#e8edf6;
        border:1px solid #39404e; border-radius:10px;
        box-shadow:0 10px 34px rgba(0,0,0,.45); overflow:hidden; user-select:none; }
      .bar { display:flex; align-items:center; gap:8px; padding:7px 10px;
        background:#232936; cursor:move; }
      .title { font-size:12.5px; font-weight:600; flex:1; }
      .count { font-size:11px; color:#93a2bd; font-weight:400; }
      .tools { display:flex; align-items:center; gap:5px; flex-wrap:wrap;
        padding:0 10px 8px; background:#232936; border-bottom:1px solid #39404e; }
      .sep { width:1px; height:16px; background:#3d4658; margin:0 3px; }
      .btn { background:#313a4c; border:0; color:#cfd9ea; border-radius:5px;
        font-size:11.5px; padding:3px 8px; cursor:pointer; line-height:1.6; white-space:nowrap; }
      .btn:hover { background:#3d4860; color:#fff; }
      .btn.on { background:#3f6ea8; color:#fff; }
      .btn.play.on { background:#c2453f; }
      .lanes { max-height:58vh; overflow-y:auto; }
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
      .grip { height:12px; background:#232936; cursor:nwse-resize; display:flex;
        align-items:center; justify-content:center; border-top:1px solid #39404e; }
      .grip::after { content:''; width:34px; height:3px; border-radius:2px; background:#4a556b; }
      .collapsed .lanes, .collapsed .grip, .collapsed .status, .collapsed .tools { display:none; }
      /* popped out: fill the whole window */
      .panel.popped { width:100%!important; height:100vh; border:0; border-radius:0;
        display:flex; flex-direction:column; box-shadow:none; }
      .panel.popped .bar { cursor:default; }
      .panel.popped .lanes { max-height:none; flex:1 1 auto; }
      .panel.popped .grip, .panel.popped [data-act="fold"] { display:none; }
    </style>
    <div class="panel">
      <div class="bar">
        <span class="title">Waveform <span class="count"></span></span>
        <button class="btn" data-act="fold">－</button>
      </div>
      <div class="tools">
        <button class="btn play" data-act="play">▶ Play</button>
        <button class="btn" data-act="align" title="Shift every lane so their first sound lines up">⇱ Align</button>
        <button class="btn" data-act="move" title="Drag the waveform sideways to shift a lane. Hold Shift to toggle temporarily.">↔ Shift</button>
        <span class="sep"></span>
        <button class="btn" data-act="sync" title="Share one time scale across all lanes">⇄ Sync</button>
        <button class="btn" data-act="gain" title="Vertical zoom, identical for every lane">Gain auto</button>
        <button class="btn" data-act="taller" title="Taller lanes">＋</button>
        <button class="btn" data-act="shorter" title="Shorter lanes">－</button>
        <span class="sep"></span>
        <button class="btn" data-act="pop" title="Move the panel into its own window — drag it to a second monitor">⧉ Pop out</button>
        <button class="btn" data-act="rescan" title="Scan the page again">Rescan</button>
        <button class="btn" data-act="clear" title="Remove all lanes">Clear</button>
      </div>
      <div class="lanes"></div>
      <div class="status"></div>
      <div class="grip"></div>
    </div>`;

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
    else if (act === 'clear')    { stopAll(); [...lanes.keys()].forEach(dropLane); }
    else if (act === 'rescan')   { scanDom(); }
    else if (act === 'pop')      { popWin && !popWin.closed ? dockBack() : popOut(); }
    else if (act === 'taller' || act === 'shorter') {
      laneH = Math.max(56, Math.min(240, laneH + (act === 'taller' ? 26 : -26)));
      applySize();
    } else if (act === 'sync') {
      syncAxis = !syncAxis; e.target.classList.toggle('on', syncAxis); refreshAll();
    } else if (act === 'gain') {
      const seq = ['auto', 1, 2, 4, 8];
      gainMode = seq[(seq.indexOf(gainMode) + 1) % seq.length];
      e.target.textContent = 'Gain ' + (gainMode === 'auto' ? 'auto' : '\u00d7' + gainMode);
      e.target.classList.toggle('on', gainMode !== 1);
      refreshAll();
    }
  };
  shadow.querySelector('.bar').addEventListener('click', onTool);
  shadow.querySelector('.tools').addEventListener('click', onTool);

  shadow.querySelector('[data-act="sync"]').classList.toggle('on', syncAxis);
  shadow.querySelector('[data-act="gain"]').classList.add('on');
  makeDraggable(shadow.querySelector('.bar'));
  makeResizable(shadow.querySelector('.grip'));
  restoreGeometry();
  paintStatus();
}

function applyCursorMode() {
  if (!shadow) return;
  shadow.querySelectorAll('.wrap').forEach(w => w.classList.toggle('move', moveMode));
}

function paintStatus() {
  if (!statusEl) return;
  statusEl.innerHTML =
    `media elements <b>${stat.media}</b> · decoded <b>${stat.dec}</b> · audio requests <b>${stat.url}</b>` +
    ` · page hook <b>${stat.hook ? 'active' : 'blocked'}</b>`;
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
  shadow.querySelector('.panel').style.width = panelW + 'px';
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
  gainVal = gainMode === 'auto'
    ? Math.max(1, Math.min(12, peak > 0.001 ? 0.94 / peak : 1))
    : gainMode;
}

function refreshAll() {
  recomputeGain();
  for (const l of lanes.values()) { redraw(l); paintCursor(l); paintOffset(l); }
  updateCount();
  paintStatus();
  applyCursorMode();
}

function relayout() { if (popWin && !popWin.closed) fitPopped(); }

/* ============ pop the panel out into its own window (for a 2nd monitor) ============ */
function popOut() {
  if (!host) return;
  if (popWin && !popWin.closed) { try { popWin.focus(); } catch (e) {} return; }

  let w = null;
  try {
    w = window.open('', 'wfWaveformPanel',
      'width=1100,height=640,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes');
  } catch (e) {}
  if (!w) {
    if (statusEl) statusEl.innerHTML =
      '\u26a0 The popup was blocked. Allow popups for this site, then try again.';
    return;
  }

  try {
    w.document.open();
    w.document.write(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
      '<title>Waveform</title>' +
      '<style>html,body{margin:0;padding:0;height:100%;background:#12151c;overflow:hidden}</style>' +
      '</head><body></body></html>');
    w.document.close();
  } catch (e) {}

  popWin = w;

  // Move the whole panel (shadow DOM included) into the popup
  try {
    w.document.body.appendChild(w.document.adoptNode(host));
  } catch (e) {
    popWin = null;
    try { w.close(); } catch (e2) {}
    if (statusEl) statusEl.innerHTML = '\u26a0 Could not move the panel: ' + (e && e.message || e);
    return;
  }

  host.style.cssText = 'position:static!important;display:block!important;' +
    'width:100%!important;height:100%!important;margin:0!important;padding:0!important;';
  shadow.querySelector('.panel').classList.add('popped');
  shadow.querySelector('.panel').classList.remove('collapsed');
  const btn = shadow.querySelector('[data-act="pop"]');
  if (btn) { btn.textContent = '⧉ Dock'; btn.classList.add('on'); }

  const onResize = () => fitPopped();
  w.addEventListener('resize', onResize);
  w.addEventListener('beforeunload', () => dockBack(true));
  w.addEventListener('keydown', onHotkey, true);

  clearInterval(popTimer);
  popTimer = setInterval(() => { if (!popWin || popWin.closed) dockBack(true); }, 800);

  fitPopped();
  setTimeout(fitPopped, 120);   // recompute once the window size has settled
}

/* Fill the popup window: width follows the window, lane height splits the remaining space */
function fitPopped() {
  if (!popWin || popWin.closed || !shadow) return;
  panelW = popWin.innerWidth;
  const chrome = 34 + 34 + 26;                 // title bar + toolbar + status bar
  const avail = Math.max(120, popWin.innerHeight - chrome);
  const n = Math.max(1, lanes.size);
  laneH = Math.max(56, Math.min(420, Math.floor(avail / n) - 34));
  shadow.querySelectorAll('canvas').forEach(c => { c.style.height = laneH + 'px'; });
  refreshAll();
}

function dockBack(fromClose) {
  clearInterval(popTimer); popTimer = 0;
  const w = popWin;
  popWin = null;
  if (!host || !shadow) return;

  try {
    if (document.body && host.ownerDocument !== document) {
      document.body.appendChild(document.adoptNode(host));
    }
  } catch (e) {}

  host.style.cssText = 'position:fixed!important;z-index:2147483600!important;' +
    'right:16px!important;bottom:16px!important;display:block!important;' +
    'width:auto!important;height:auto!important;margin:0!important;padding:0!important;';
  shadow.querySelector('.panel').classList.remove('popped');
  const btn = shadow.querySelector('[data-act="pop"]');
  if (btn) { btn.textContent = '⧉ Pop out'; btn.classList.remove('on'); }

  panelW = 640; laneH = 96;
  try {
    api.storage.local.get('geom').then(({ geom }) => {
      if (geom) { panelW = geom.w || panelW; laneH = geom.h || laneH; }
      shadow.querySelectorAll('canvas').forEach(c => { c.style.height = laneH + 'px'; });
      applySize();
    }).catch(() => applySize());
  } catch (e) { applySize(); }

  if (!fromClose && w && !w.closed) { try { w.close(); } catch (e) {} }
}

/* dragging / resizing / persisted geometry */
function makeDraggable(handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.target.dataset && e.target.dataset.act) return;
    const r = host.getBoundingClientRect();
    ['left', 'top'].forEach((k, i) => host.style.setProperty(k, (i ? r.top : r.left) + 'px', 'important'));
    ['right', 'bottom'].forEach(k => host.style.setProperty(k, 'auto', 'important'));
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

function makeResizable(grip) {
  grip.addEventListener('mousedown', (e) => {
    const sx = e.clientX, sy = e.clientY, sw = panelW, sh = laneH;
    const mv = (ev) => {
      panelW = Math.max(340, Math.min(1500, sw + (ev.clientX - sx)));
      laneH = Math.max(56, Math.min(240, sh + (ev.clientY - sy)));
      applySize();
    };
    const up = () => { winOf().removeEventListener('mousemove', mv); winOf().removeEventListener('mouseup', up); };
    winOf().addEventListener('mousemove', mv); winOf().addEventListener('mouseup', up);
    e.preventDefault();
  });
}

function saveGeometry() {
  if (popWin && !popWin.closed) return;
  try {
    const r = host.getBoundingClientRect();
    api.storage.local.set({ geom: { left: r.left, top: r.top, w: panelW, h: laneH } });
  } catch (e) {}
}

function restoreGeometry() {
  try {
    api.storage.local.get('geom').then(({ geom }) => {
      if (!geom) return;
      panelW = geom.w || panelW; laneH = geom.h || laneH;
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
  if (lanes.size >= MAX_LANES) {
    const victim = [...lanes.entries()].find(([, l]) => !l.pinned);
    if (victim) dropLane(victim[0]); else return;
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
    buffer: null,
    duration: spec.duration || (spec.peaks && spec.peaks.duration) || 0,
    offset: 0, muted: false, pinned: false, raf: 0,
    raw: null, mime: '', selA: null, selB: null
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

  if (lane.el) wireMedia(lane);
  wireMouse(lane);

  if (lane.url) loadPeaks(lane);      // Always fetch a full buffer so we can play it, even if preview peaks already arrived

  refreshAll();
  relayout();
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

function dropLane(key) {
  const lane = lanes.get(key);
  if (!lane) return;
  winOf().cancelAnimationFrame(lane.raf);
  lane.detach && lane.detach();
  lane.node.remove();
  lanes.delete(key);
  refreshAll();
  relayout();
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

function paintOffset(lane) {
  lane.offEl.textContent = Math.abs(lane.offset) < 0.001 ? ''
    : (lane.offset > 0 ? '+' : '') + lane.offset.toFixed(3) + 's';
}

function paintCursor(lane) {
  const { t0, span } = laneAxis(lane);
  const W = lane.wrap.clientWidth;
  let t = null;
  if (T.playing) t = T.pos;
  else if (lane.el && lane.el.currentTime > 0) t = lane.offset + lane.el.currentTime;
  else if (T.pos > 0) t = T.pos;
  if (t == null || !span) { lane.curEl.style.display = 'none'; return; }
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
  if (!buf) { if (!lane.peaks) fail(lane, err || 'Could not read the audio data'); return; }

  let audio;
  try { audio = await actx().decodeAudioData(buf.slice(0)); }
  catch (e) { if (!lane.peaks) fail(lane, 'Decode failed — this browser cannot decode that codec'); return; }

  if (buf.byteLength <= 25 * 1024 * 1024) { lane.raw = buf; lane.mime = guessMime(url); }
  const peaks = computePeaks(audio);
  peakCache.set(url, { peaks, buffer: audio, raw: lane.raw, mime: lane.mime });
  if (peakCache.size > 12) peakCache.delete(peakCache.keys().next().value);
  lane.peaks = peaks; lane.buffer = audio; lane.duration = peaks.duration;
  lane.metaEl.textContent = fmtSec(peaks.duration);
  refreshAll();
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
function encodeWav(buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);
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
  return new Blob([ab], { type: 'audio/wav' });
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

  if (hasSel) {
    if (!lane.buffer) { flash(lane, 'no audio data'); return; }
    const a = Math.max(0, lane.selA), b = Math.min(lane.duration, lane.selB);
    saveBlob(encodeWav(lane.buffer, a, b),
             `${base}_${a.toFixed(2)}-${b.toFixed(2)}s.wav`);
    flash(lane, 'saved ' + (b - a).toFixed(2) + 's');
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
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const RULER = 14, waveH = cssH - RULER, mid = waveH / 2;
  const { t0, span } = laneAxis(lane);
  const startT = syncAxis ? lane.offset : 0;
  const xa = Math.round((startT - t0) / span * cssW);
  const xb = Math.round((startT + lane.duration - t0) / span * cssW);
  const L = Math.max(0, xa), R = Math.min(cssW, xb);

  g.fillStyle = COLOR.dead; g.fillRect(0, 0, cssW, waveH);
  g.fillStyle = lane.muted ? COLOR.fieldMute : COLOR.field;
  g.fillRect(L, 0, Math.max(0, R - L), waveH);

  const { mins, maxs } = lane.peaks, N = mins.length;
  const W = Math.max(1, xb - xa);
  g.fillStyle = lane.muted ? COLOR.waveMute : COLOR.wave;
  for (let x = L; x < R; x++) {
    const u = x - xa;
    const a = Math.floor(u * N / W), b = Math.max(a + 1, Math.floor((u + 1) * N / W));
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
  if (e.code === 'Space' && (e.ctrlKey || e.metaKey || popWin)) { e.preventDefault(); toggleAll(); }
}
addEventListener('keydown', onHotkey);

/* ============================ on/off ============================ */
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'wf:enabled') {
    enabled = msg.enabled;
    if (!enabled) {
      stopAll();
      if (popWin && !popWin.closed) { try { popWin.close(); } catch (e) {} popWin = null; }
      clearInterval(popTimer);
      [...lanes.keys()].forEach(dropLane);
      if (host) { host.remove(); host = null; shadow = null; lanesBox = null; statusEl = null; }
    } else { ensurePanel(); scanDom(); }
  }
});

try {
  api.runtime.sendMessage({ type: 'wf:getEnabled' })
    .then((r) => { enabled = !r || r.enabled !== false; if (enabled) boot(); })
    .catch(() => boot());
} catch (e) { boot(); }

function boot() { scanDom(); [400, 1200, 3000].forEach(t => setTimeout(scanDom, t)); }

addEventListener('resize', () => refreshAll());
})();
