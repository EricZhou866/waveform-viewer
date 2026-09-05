# Manual test pages

Serve this folder over HTTP (`python3 -m http.server`) and drop two short audio
files named `ref.mp3` and `mine.mp3` next to the HTML files.

- `real.html` — plays audio purely through the Web Audio API. There is **no**
  `<audio>` element anywhere on the page. This exercises the `decodeAudioData`
  detection route.
- `demo.html` — a small mock "practice" page with two clips, used for the store
  screenshots.
