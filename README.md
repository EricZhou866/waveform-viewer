# Waveform Viewer

A browser extension that draws a real waveform for any audio a web page plays, so
you can compare two recordings, align them, measure intervals to the millisecond,
and download what you selected.

![compare](store/screenshots/01-compare.png)

## Why

Comparing two recordings normally means downloading both files, opening a desktop
audio editor, lining them up by hand, and reading timings off a ruler. This does
all of that in the page, in a panel you can pop onto a second monitor.

## Features

- **Waveform per clip**, stacked as lanes in a floating panel
- **One shared time scale** so lanes line up vertically and pacing differences show
- **Align onsets** in one click, or drag a lane sideways with millisecond readout
- **Synced playback** of every lane through a single playhead; mute or solo lanes
- **Drag to measure** any interval to three decimal places
- **Download** the selected region as WAV, or the original file untouched
- **Pop out** into a separate window you can drag to another monitor
- Finds audio through four routes, including Web Audio players that never create an
  `<audio>` element

Nothing is uploaded anywhere. No accounts, no analytics, no remote code.

## Install

**From the stores** — Chrome Web Store / Firefox Add-ons (links once published).

**From source**

```bash
git clone <repo> && cd waveform-viewer
./build.sh          # writes dist/waveform-viewer-{chrome,firefox}-<ver>.zip
```

- *Chrome*: `chrome://extensions` → Developer mode → **Load unpacked** → `build/chrome`
- *Firefox*: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
  `build/firefox/manifest.json` (temporary add-ons are removed when Firefox restarts)

## Usage

The panel appears in the bottom-right as soon as audio is detected.

### Toolbar

| Button | What it does |
|---|---|
| `▶ Play` | Play every un-muted lane together on one playhead. `Ctrl/⌘ + Space` |
| `⇱ Align` | Shift every lane so their first audible moment lines up |
| `↔ Shift` | Drag a lane sideways to align by hand (hold **Shift** to toggle temporarily) |
| `⇄ Sync` | One time scale for all lanes — keep this on when comparing |
| `Gain auto` | Vertical zoom, identical across lanes so loudness stays comparable |
| `＋` / `－` | Lane height |
| `⧉ Pop out` | Move the panel into its own window (drag it to a second monitor) |
| `Rescan` / `Clear` | Scan the page again / remove all lanes |

### Per lane

| Control | What it does |
|---|---|
| `☆` | Pin — never auto-evicted when new audio appears |
| `+0.576s` | Current time offset; click to reset to zero |
| `⬇` | Download: the selection as WAV, or the whole original file |
| `◉` | Solo — mute every other lane |
| `🔊 / 🔇` | Mute this lane |
| `✕` | Remove this lane |

### On the waveform

| Action | Result |
|---|---|
| Click | Move the playhead there (restarts playback from that point if playing) |
| Drag | Select a region — the header shows its exact length |
| Drag with `↔ Shift` on, or holding Shift | Move that lane in time |
| Double-click | Clear the selection |

## Comparing two recordings

1. Play the reference clip — lane 1 appears. Pin it with `☆`.
2. Play your own recording — lane 2 appears.
3. Make sure `⇄ Sync` is on.
4. Hit `⇱ Align`. Both onsets now start together.
5. `▶ Play` to hear them layered; `🔇` one lane to hear just the other.
6. Drag across any pause to read its exact length.
7. `⬇` to save a region as WAV.

## Troubleshooting

The status line at the bottom of the panel reports what was detected:

```
media elements 2 · decoded 1 · audio requests 3 · page hook active
```

- **No panel at all** — the extension is not running. Reload the extension, then
  hard-reload the page.
- **page hook blocked** — the page's CSP blocked the injected hook, so only
  `<audio>`/`<video>` elements can be found; Web Audio players will be missed.
- **All counters zero** — play some audio first. Still zero means the page uses a
  path this extension does not cover.
- **A lane shows ⚠** — the audio bytes could not be read; the message says why.
  Media Source Extensions (adaptive streams) and DRM-protected audio cannot be read.

## Limits

- MSE / DRM-protected streams cannot be decoded
- Files over 60 MB are skipped
- A popped-out window belongs to its tab: closing or navigating that tab ends it
- Max 4 lanes at once (oldest un-pinned lane is evicted)

## Layout

```
src/              shared source for both browsers
  content.js      panel UI, rendering, transport, download
  page-hook.js    page-world hook, reports back via postMessage
  background.js   toolbar toggle + cross-origin audio proxy
manifests/
  chrome.json       MV3, service worker
  firefox.json      MV2  (default for Firefox)
  firefox-mv3.json  MV3 alternative
build.sh          copies src/ + the right manifest into build/, zips into dist/
store/            listing copy, privacy policy, reviewer notes, screenshots
test/             manual test pages
```

## License

MIT — see [LICENSE](LICENSE).
