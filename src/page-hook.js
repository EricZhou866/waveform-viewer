/* Waveform Viewer — page-world hook.
 *
 * A content script lives in an isolated world and cannot see objects the page
 * creates. This file is injected into the page world instead, and records
 * "there is audio here" through four independent routes and posting the results
 * back with window.postMessage — the only channel that works on both engines
 * (Chrome content scripts cannot read page-world variables at all; Firefox's
 * wrappedJSObject is Firefox-only).
 *
 *   1. <audio>/<video> elements, including `new Audio()` instances that never
 *      enter the DOM
 *   2. AudioContext.decodeAudioData — the path every Web Audio player
 *      (wavesurfer.js and friends) must take. Peaks are computed right here,
 *      so the content script does not have to download the file again.
 *   3. fetch() responses that look like audio
 *   4. XMLHttpRequest responses that look like audio
 *
 * Everything is wrapped in try/catch: if one route fails the others still work.
 */
(function () {
  if (window.__wfHookInstalled) return;
  window.__wfHookInstalled = true;

  var PEAK_N = 2048;
  var seq = 0;
  var seenUrls = [];
  var lastUrl = '';

  function post(msg) {
    try { msg.__wf = 1; window.postMessage(msg, '*'); } catch (e) {}
  }

  var AUDIO_RE = /\.(mp3|wav|m4a|mp4a|aac|ogg|oga|opus|flac|weba|webm)(\?|#|$)/i;

  function isAudioUrl(u, ct) {
    if (ct && /^(audio\/|application\/ogg)/i.test(ct)) return true;
    if (!u) return false;
    if (u.indexOf('blob:') === 0 || u.indexOf('data:audio') === 0) return true;
    try { return AUDIO_RE.test(new URL(u, location.href).pathname); }
    catch (e) { return AUDIO_RE.test(u); }
  }

  function pushUrl(u) {
    if (!u || seenUrls.indexOf(u) !== -1) return;
    seenUrls.push(u);
    if (seenUrls.length > 48) seenUrls.shift();
    lastUrl = u;
    post({ kind: 'url', url: u });
  }

  /* Media elements cannot cross the world boundary, so only their source is
     sent. DOM elements are found by the content script's own scan anyway;
     this covers detached `new Audio()` instances. */
  function pushMedia(el) {
    if (!el) return;
    var send = function () {
      var u = '';
      try { u = el.currentSrc || el.src || ''; } catch (e) {}
      if (u) pushUrl(u);
    };
    send();
    try {
      el.addEventListener('loadedmetadata', send);
      el.addEventListener('play', send);
    } catch (e) {}
  }

  /* ---------- 1. media elements ---------- */
  try {
    var NativeAudio = window.Audio;
    if (NativeAudio) {
      var Patched = function (src) {
        var el = src === undefined ? new NativeAudio() : new NativeAudio(src);
        pushMedia(el);
        return el;
      };
      Patched.prototype = NativeAudio.prototype;
      window.Audio = Patched;
    }
  } catch (e) {}

  try {
    var mp = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (mp) {
      ['play', 'load'].forEach(function (name) {
        var native = mp[name];
        if (typeof native !== 'function') return;
        mp[name] = function () { pushMedia(this); return native.apply(this, arguments); };
      });
    }
  } catch (e) {}

  document.addEventListener('loadedmetadata', function (e) {
    if (e.target instanceof HTMLMediaElement) pushMedia(e.target);
  }, true);

  /* ---------- 2. decodeAudioData (the important one) ---------- */
  function peaksOf(buffer) {
    var ch = buffer.numberOfChannels, n = buffer.length;
    var N = Math.min(PEAK_N, Math.max(128, n));
    var mins = new Float32Array(N), maxs = new Float32Array(N);
    var data = [];
    for (var c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    var step = n / N;
    for (var i = 0; i < N; i++) {
      var s = Math.floor(i * step);
      var e = Math.max(s + 1, Math.min(n, Math.floor((i + 1) * step)));
      var mn = 0, mx = 0;
      for (var j = s; j < e; j++) {
        var v = 0;
        for (var k = 0; k < ch; k++) v += data[k][j];
        v /= ch;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[i] = mn;
      maxs[i] = mx;
    }
    return { mins: mins, maxs: maxs };
  }

  function recordBuffer(buffer) {
    try {
      if (!buffer || !buffer.length) return;
      var p = peaksOf(buffer);
      post({ kind: 'decoded', id: ++seq, url: lastUrl,
             duration: buffer.duration, mins: p.mins, maxs: p.maxs });
    } catch (e) {}
  }

  try {
    var Base = window.BaseAudioContext || window.AudioContext;
    if (Base && Base.prototype.decodeAudioData) {
      var nativeDecode = Base.prototype.decodeAudioData;
      Base.prototype.decodeAudioData = function (buf, ok, bad) {
        var self = this;
        var wrappedOk = typeof ok === 'function'
          ? function (b) { recordBuffer(b); return ok.call(self, b); }
          : ok;
        var r = nativeDecode.call(this, buf, wrappedOk, bad);
        if (r && typeof r.then === 'function') {
          return r.then(function (b) { recordBuffer(b); return b; });
        }
        return r;
      };
    }
  } catch (e) {}

  /* ---------- 3. fetch ---------- */
  try {
    var nativeFetch = window.fetch;
    if (nativeFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        return nativeFetch.apply(this, arguments).then(function (res) {
          try {
            var ct = res.headers && res.headers.get && res.headers.get('content-type');
            if (isAudioUrl(res.url || url, ct)) pushUrl(res.url || url);
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}

  /* ---------- 4. XMLHttpRequest ---------- */
  try {
    var xp = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (xp) {
      var nativeOpen = xp.open;
      xp.open = function (method, url) {
        this.__wfUrl = url;
        return nativeOpen.apply(this, arguments);
      };
      var nativeSend = xp.send;
      xp.send = function () {
        var self = this;
        this.addEventListener('load', function () {
          try {
            var ct = self.getResponseHeader && self.getResponseHeader('content-type');
            var u = self.responseURL || self.__wfUrl;
            if (isAudioUrl(u, ct)) pushUrl(u);
          } catch (e) {}
        });
        return nativeSend.apply(this, arguments);
      };
    }
  } catch (e) {}

  /* ---------- 5. backfill: requests that already completed ---------- */
  try {
    performance.getEntriesByType('resource').forEach(function (r) {
      if (isAudioUrl(r.name) || r.initiatorType === 'audio' || r.initiatorType === 'video') pushUrl(r.name);
    });
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (r) {
        if (isAudioUrl(r.name) || r.initiatorType === 'audio' || r.initiatorType === 'video') pushUrl(r.name);
      });
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}

  post({ kind: 'ready' });
})();
