# Tests

## `e2e.js` — the regression run

Drives the real, built extension in Chromium. Most bugs in this project live in the
seams between the page world, the isolated world, the background and the standalone
window, and mocking those away is exactly what hides them.

```bash
./build.sh                                    # e2e.js runs against build/chrome
npm i -D playwright && npx playwright install chromium
node test/e2e.js
```

The audio fixtures are WAVs generated in-process and served through Playwright
routing, so there are no binary files to keep in the repo and no listening socket.

Three things about the environment are not obvious (see DESIGN.md §20.3):

- It will not work against the Chrome installed on your machine — Chrome 137+ ignores
  `--load-extension`. The harness uses Playwright's own Chromium.
- Playwright passes `--disable-extensions` by default, so the harness overrides it
  with `ignoreDefaultArgs`, and needs `channel: 'chromium'` because extensions do not
  load in the headless shell.
- The in-page panel is only created once the first lane exists, so the run plays
  audio before asserting anything about the panel.

## Manual pages

Serve this folder over HTTP (`python3 -m http.server`) and drop two short audio
files named `ref.mp3` and `mine.mp3` next to the HTML files.

- `real.html` — plays audio purely through the Web Audio API. There is **no**
  `<audio>` element anywhere on the page. This exercises the `decodeAudioData`
  detection route.
- `demo.html` — a small mock "practice" page with two clips, used for the store
  screenshots.
