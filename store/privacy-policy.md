# Privacy Policy — Waveform Viewer

*Last updated: 2026-09-10*

Waveform Viewer does not collect, transmit, sell, or share any personal data.

## What the extension stores

Everything below is kept in your browser's local extension storage, on your own
device:

1. Whether the extension is enabled or disabled.
2. The waveform panel's position and size.
3. Your settings — how many waveforms to show at once, the minimum clip length,
   whether new audio is cropped and aligned automatically, cropping strength,
   vertical zoom, and which toolbar buttons are shown.
4. When you open the panel in its own window, the audio being handed to that
   window. Audio the page holds internally cannot be re-read from an extension
   page, so a copy of those bytes is written to local storage to get it across.
   It is cleared when you switch the extension off.

That is the complete list. None of it ever leaves your device, and all of it is
removed when you uninstall the extension.

## What the extension accesses

To draw a waveform, the extension needs the audio the page you are visiting has
already loaded. It observes the page for audio activity and reads those audio
files — the same files your browser has already downloaded to play them. The audio
is decoded in your browser and drawn to a canvas.

While the extension is switched off it does not touch pages at all: the script
that watches for audio is not added to them.

The extension does not read page text, form input, passwords, cookies, or browsing
history, and it does not track which sites you visit.

## What the extension sends

Nothing. There is no server, no account, no analytics, no telemetry, and no error
reporting. The extension makes no network requests other than re-reading audio
files from the site you are already on.

## Downloads

When you use the download button, the file is created in your browser from audio
already in memory and saved by your browser's normal download flow. Nothing is
uploaded anywhere.

## Third parties

None. The extension bundles no third-party libraries, analytics SDKs, or remote code.

## Changes

Any change to this policy will be published with a new version of the extension and
reflected in the "last updated" date above.

## Contact

Questions: EricZhou866@gmail.com
