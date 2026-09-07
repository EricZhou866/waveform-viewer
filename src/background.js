/* Waveform Viewer — background script.
 *
 * Runs as an MV2 background page on Firefox and as an MV3 service worker on
 * Chrome, so it must not assume either environment:
 *   - `browser` vs `chrome`
 *   - `browserAction` vs `action`
 *   - service workers are terminated aggressively, so nothing is cached in
 *     module scope; the on/off flag always comes from storage.
 *
 * Three jobs:
 *   1. toolbar button = global on/off switch
 *   2. proxy audio downloads for the content script when page CORS blocks it
 *   3. own the standalone panel window and the lane list handed to it
 */

const api = (typeof browser !== 'undefined') ? browser : chrome;
const action = api.action || api.browserAction;

const MAX_BYTES = 60 * 1024 * 1024;

async function isEnabled() {
  try {
    const r = await api.storage.local.get('enabled');
    return r.enabled !== false;
  } catch (e) { return true; }
}

async function paintButton() {
  const on = await isEnabled();
  try {
    await action.setBadgeText({ text: on ? '' : 'off' });
    await action.setBadgeBackgroundColor({ color: '#767676' });
    await action.setTitle({
      title: on ? 'Waveform Viewer: on (click to disable)'
                : 'Waveform Viewer: off (click to enable)'
    });
  } catch (e) {}
}

api.runtime.onInstalled.addListener(paintButton);
api.runtime.onStartup && api.runtime.onStartup.addListener(paintButton);
paintButton();

async function toggleEnabled() {
  const next = !(await isEnabled());
  await api.storage.local.set({ enabled: next });
  await paintButton();
  // Turning it off must leave nothing behind: in-page panels and the
  // standalone window all go away.
  if (!next) {
    await closePanelWindow();
    try { await api.storage.local.set({ panelLanes: [] }); } catch (e) {}
  }
  await broadcastTabs({ type: 'wf:enabled', enabled: next });
  return next;
}

action.onClicked.addListener(toggleEnabled);

/* ---- standalone panel window ----
 * A real extension window, so the user can drag it to another monitor and it
 * outlives the tab. The lane list is kept in storage rather than a module
 * variable, because an MV3 service worker is torn down between messages.
 */
let panelWindowId = null;
let panelTabId = null;   // the tab whose lanes the window mirrors

async function broadcastTabs(msg) {
  try {
    const tabs = await api.tabs.query({});
    for (const t of tabs) {
      try { await api.tabs.sendMessage(t.id, msg); } catch (e) { /* no content script */ }
    }
  } catch (e) {}
}

/* Clearing panelWindowId before the remove() means onRemoved sees a window it no
   longer owns and stays quiet, so callers that want the tabs told say so. */
async function closePanelWindow(notify) {
  const id = panelWindowId;
  panelWindowId = null;
  panelTabId = null;
  if (id === null) return;
  try { await api.windows.remove(id); } catch (e) {}
  if (notify) await broadcastTabs({ type: 'wf:panelClosed' });
}

/* Rebuild the lane list from primitives before it touches storage. A value that
   cannot be coerced is dropped; nothing here is allowed to stop the window from
   opening. */
function sanitizeLanes(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    try {
      if (!d) continue;
      const p = {
        url: String(d.url || ''),
        label: String(d.label || 'audio'),
        offset: Number(d.offset) || 0,
        muted: !!d.muted
      };
      if (typeof d.b64 === 'string' && d.b64) { p.b64 = d.b64; p.mime = String(d.mime || ''); }
      if (d.unavailable) p.unavailable = true;
      out.push(p);
    } catch (e) { /* skip this one */ }
  }
  return out;
}

async function showWindow() {
  if (panelWindowId !== null) {
    try {
      await api.windows.update(panelWindowId, { focused: true });
      return true;
    } catch (e) { panelWindowId = null; }
  }
  const w = await api.windows.create({
    url: api.runtime.getURL('panel.html'),
    type: 'popup',
    width: 1100,
    height: 640
  });
  panelWindowId = w.id;
  return true;
}

async function openPanel(lanes, tabId) {
  panelTabId = (tabId === undefined) ? panelTabId : tabId;

  // The window comes first. Whatever happens to the payload, the user asked for
  // a window and must get one.
  try {
    await showWindow();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // Snapshot is only a fallback for when the tab has gone away; the live list is
  // pulled from the tab on demand.
  let partial = false;
  try {
    await api.storage.local.set({ panelLanes: sanitizeLanes(lanes) });
  } catch (e) {
    partial = true;
    try { await api.storage.local.set({ panelLanes: [] }); } catch (e2) {}
  }

  broadcastTabs({ type: 'wf:panelOpen' });
  return partial ? { ok: true, partial: true } : { ok: true };
}

if (api.windows && api.windows.onRemoved) {
  api.windows.onRemoved.addListener((id) => {
    if (id !== panelWindowId) return;
    panelWindowId = null;
    panelTabId = null;
    broadcastTabs({ type: 'wf:panelClosed' });   // give the in-page panel back
  });
}

/* A lane the tab found after the window was already open — just forward it.
 * Nothing is accumulated here: a lane that is later merged away or removed must
 * not survive in a stale list. */
async function forwardLane(lane) {
  if (panelWindowId === null) return;
  const clean = sanitizeLanes([lane])[0];
  if (!clean) return;
  try { await api.runtime.sendMessage({ type: 'wf:panelLaneFwd', lane: clean }); } catch (e) {}
}

/* Ask the tab for the lanes it has right now. */
async function currentLanes() {
  if (panelTabId !== null) {
    try {
      const r = await api.tabs.sendMessage(panelTabId, { type: 'wf:collectLanes' });
      if (r && Array.isArray(r.lanes)) return sanitizeLanes(r.lanes);
    } catch (e) { /* tab closed or navigated */ }
  }
  try {
    const { panelLanes } = await api.storage.local.get('panelLanes');
    return sanitizeLanes(panelLanes);
  } catch (e) { return []; }
}

/* `return true` keeps the channel open for the async reply on both engines. */
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'wf:getEnabled') {
    isEnabled().then((enabled) => sendResponse({ enabled }));
    return true;
  }
  if (msg.type === 'wf:fetch') {
    proxyFetch(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'wf:openPanel') {
    openPanel(msg.lanes, sender && sender.tab ? sender.tab.id : undefined).then(sendResponse);
    return true;
  }
  if (msg.type === 'wf:dockPanel') {
    // Back into the page: close the window, then hand the tab its panel back.
    closePanelWindow(true).then(() => sendResponse({ ok: true }))
                          .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'wf:getPanelData') {
    currentLanes().then((lanes) => sendResponse({ lanes })).catch(() => sendResponse({ lanes: [] }));
    return true;
  }
  if (msg.type === 'wf:panelLane') {
    forwardLane(msg.lane);
    return;
  }
});

/* The background has host permissions, so it is not bound by the page's CORS. */
async function proxyFetch(url) {
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) return { error: 'HTTP ' + res.status };

    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) {
      return { error: 'File too large (' + (len / 1048576).toFixed(1) + ' MB)' };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { error: 'File too large' };

    // Extension messages are JSON-serialised, so an ArrayBuffer cannot cross
    // the channel. base64 is the pragmatic way through.
    return { b64: bufToB64(buf) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function bufToB64(buf) {
  const u8 = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
