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

action.onClicked.addListener(async () => {
  const next = !(await isEnabled());
  await api.storage.local.set({ enabled: next });
  await paintButton();
  try {
    const tabs = await api.tabs.query({});
    for (const t of tabs) {
      try { await api.tabs.sendMessage(t.id, { type: 'wf:enabled', enabled: next }); }
      catch (e) { /* tab has no content script — fine */ }
    }
  } catch (e) {}
});

/* ---- standalone panel window ----
 * A real extension window, so the user can drag it to another monitor and it
 * outlives the tab. The lane list is kept in storage rather than a module
 * variable, because an MV3 service worker is torn down between messages.
 */
let panelWindowId = null;

async function openPanel(lanes) {
  try { await api.storage.local.set({ panelLanes: lanes || [] }); } catch (e) {}
  try {
    if (panelWindowId !== null) {
      try {
        await api.windows.update(panelWindowId, { focused: true });
        return { ok: true, reused: true };
      } catch (e) { panelWindowId = null; }
    }
    const w = await api.windows.create({
      url: api.runtime.getURL('panel.html'),
      type: 'popup',
      width: 1100,
      height: 640
    });
    panelWindowId = w.id;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

if (api.windows && api.windows.onRemoved) {
  api.windows.onRemoved.addListener((id) => { if (id === panelWindowId) panelWindowId = null; });
}

/* A lane the tab found after the window was already open. Remember it (so a
 * reopened window still has it) and forward it to the window if it is up. */
async function rememberLane(lane) {
  try {
    const { panelLanes } = await api.storage.local.get('panelLanes');
    const list = Array.isArray(panelLanes) ? panelLanes : [];
    const key = lane.url || ('file:' + lane.label);
    if (!list.some(l => (l.url || ('file:' + l.label)) === key)) {
      list.push(lane);
      while (list.length > 8) list.shift();
      await api.storage.local.set({ panelLanes: list });
    }
  } catch (e) {}
  if (panelWindowId === null) return;
  try { await api.runtime.sendMessage({ type: 'wf:panelLaneFwd', lane }); } catch (e) {}
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
    openPanel(msg.lanes).then(sendResponse);
    return true;
  }
  if (msg.type === 'wf:getPanelData') {
    api.storage.local.get('panelLanes')
      .then(({ panelLanes }) => sendResponse({ lanes: panelLanes || [] }))
      .catch(() => sendResponse({ lanes: [] }));
    return true;
  }
  if (msg.type === 'wf:panelLane') {
    rememberLane(msg.lane);
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
