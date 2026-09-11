# Notes for reviewers
## What it does
Draws waveforms for audio the visited page loads, so the user can compare two
recordings, measure intervals, and download a clip. Everything runs locally.

## Why `<all_urls>`
The user decides which page to inspect, so the sites cannot be listed in
advance. The content script must run at `document_start` to observe audio the
page loads, and cross-origin audio (CDN-hosted, no CORS headers) can only be
re-read from the background context.

## Why a script runs in the page world (`page-hook.js`)
Many players never create an `<audio>` element: they `fetch()` the file and play
it through `decodeAudioData` + `AudioBufferSourceNode`, which a content script
in the isolated world cannot see. `page-hook.js` observes that and reports back
via `window.postMessage`. It ships inside the package as a web-accessible
resource — no remote code is loaded, and there is no `eval`.

It wraps `Audio`, `HTMLMediaElement.play/load`, `decodeAudioData`, `fetch` and
`XMLHttpRequest.open/send`. Every wrapper calls the original and returns its
result unchanged; nothing is blocked, altered or recorded beyond the audio URL
and a computed peak envelope. Messages from the page are treated as untrusted:
their shape is validated and they are only ever used to draw a waveform.

**It is not injected while the extension is switched off.** The content script
asks the background for the on/off state and injects only after a definite
"on", so a page visited with the extension disabled has nothing replaced.

## Panel window, local files, network
`⧉` asks the background to open `panel.html` via `windows.create`; it runs the
same `content.js` in panel mode. Lanes cross as descriptors — a URL, or base64
bytes when the audio is a `blob:` an extension page cannot fetch. No
cross-window DOM access. `⇲` returns the panel to the page.

`⊕` and drag-and-drop use a plain file input; files are read with
`File.arrayBuffer()`, decoded and drawn. Nothing is ever uploaded: the
extension contacts no server of its own, and its only requests are `GET`s for
audio URLs the page already requested. No accounts, no analytics.

## Code
No build step, no minifier, no bundler, no dependencies — the files in the
package are the source. The source archive also has `build.sh` (it copies
`src/` and picks a manifest), `DESIGN.md`, and `test/e2e.js`.

## Testing it
Open a page that plays audio, play something, and a dark panel appears at the
bottom right. Play a second clip for a second lane, then `▶` to hear them
together or drag across a waveform to measure an interval.

Two things worth knowing: the panel is only created once audio has been found,
so a page where nothing has played shows nothing — clicking the toolbar button
always shows it in the current tab, and the line along its bottom reports what
was detected. And clips under 2 seconds are ignored by default (Settings), as
many players fire a silent primer before every playback.
