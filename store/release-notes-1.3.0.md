# AMO release notes — 1.3.0

Paste the section below into the **Release Notes** field when submitting the
version. It covers everything since 1.0.0, the last version published on AMO
(1.1.4 and 1.1.5 were never submitted).

---

Finds far more audio than 1.0.0 did. Many players never create an `<audio>`
element — they fetch the file and play it through the Web Audio API, leaving
nothing in the DOM. Those are now picked up, alongside `<audio>`/`<video>`
elements, `fetch`, `XMLHttpRequest`, and audio the page had already loaded before
the extension started. A status line at the bottom of the panel says what was
detected, so a page it cannot read is obvious instead of silently empty.

New in this version:

- **Aligned on arrival.** Audio comes in with the silence cropped off both ends
  and every clip starting at zero — the comparison is ready without a click.
  Press ⇱ Align to see the clips at full length again.
- **No limit on lanes.** Every clip that arrives gets a waveform; the list
  scrolls. Earlier versions stopped at four and queued the rest out of sight.
- **Minimum clip length** (Settings, 2 seconds by default, 0.5–10). Keeps the
  silent primers players fire before playback, UI blips and ad stingers out of
  the way.
- **Resize the panel from any edge or corner**, and drag it anywhere on the page.
  Its size and position are remembered.
- **⇲ Dock** in the standalone window puts the panel back into the page.

Also since 1.0.0:

- A **standalone panel window** you can drag to a second monitor. It is a real
  browser window, so it survives navigating away from the tab.
- Repeats of the same clip are **merged automatically**. Sites mint a fresh
  `blob:` URL on every play, so lanes are de-duplicated by an audio fingerprint
  rather than by URL.
- **Open local files** with ⊕ Files or by dropping them on the panel.
- **Download** a selected region as WAV, or the original file untouched.
- **Rescan** for players that replay from memory without a fresh request.
- Settings for lane count, shared time scale, vertical zoom, and crop strength.

Still entirely local: no accounts, no servers, no analytics, no remote code.

Requires Firefox 140 or later (142 on Android).
