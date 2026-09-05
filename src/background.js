/* Waveform Viewer — background script.
 *
 * Runs as an MV2 background page on Firefox and as an MV3 service worker on
 * Chrome, so it must not assume either environment:
 *   - `browser` vs `chrome`
 *   - `browserAction` vs `action`
 *   - service workers are terminated aggressively, so nothing is cached in
 *     module scope; the on/off flag always comes from storage.
 *
 * Two jobs:
 *   1. toolbar button = global on/off switch
 *   2. proxy audio downloads for the content script when page CORS blocks it
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
