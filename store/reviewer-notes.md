# Notes for reviewers

## What the extension does
Renders waveforms for audio that the visited page loads, so the user can compare
recordings, measure intervals, and download clips. Everything runs locally.

## Why `<all_urls>` / broad host access
The user decides which page they want to inspect, so the site list cannot be known
in advance. The content script must be active at `document_start` in order to
observe audio the page loads, and cross-origin audio (CDN-hosted, no CORS headers)
can only be re-read from the background context.

## Why a script is injected into the page world (`page-hook.js`)
Many web players never create an `<audio>` element; they `fetch()` the file and play
it through `AudioContext.decodeAudioData` + `AudioBufferSourceNode`. A content
script in the isolated world cannot observe that. `page-hook.js` runs in the page
world and reports what it sees back via `window.postMessage`. It is a
web-accessible resource shipped inside the package — no remote code is loaded.

The hook wraps `Audio`, `HTMLMediaElement.prototype.play/load`,
`BaseAudioContext.prototype.decodeAudioData`, `window.fetch`, and
`XMLHttpRequest.prototype.open/send`. Every wrapper calls the original function and
returns its result unchanged; nothing is blocked, altered, or recorded beyond the
audio URL and the computed peak envelope.

Messages arriving from the page are treated as untrusted: the content script
validates their shape and uses them only to draw a waveform.

## Code
No build step, no minification, no bundler. The files in the package are the
source files. Source layout and the build script (which only copies files and
selects a manifest) are in the source archive.

## Network
The extension contacts no servers of its own. The only requests it makes are `GET`
requests for audio URLs the page has already requested.

## Testing it
1. Open any page that plays audio (a podcast page or a music player works).
2. Play something. A dark panel appears in the bottom-right corner with a waveform.
3. Play a second clip to get a second lane, then use Align / Play / the download button.
A minimal test page is included in the source archive under `test/`.
