# Store listing copy (English)

## Name (both stores)
Waveform Viewer — compare & measure audio

*Chrome max 75 chars · Firefox max 50 chars for the add-on name.*
Firefox short form if needed: **Waveform Viewer**

## Short description / summary  (Chrome: max 132 chars)
Draw waveforms for any audio on a page. Compare recordings side by side, align onsets, measure pauses, download clips.

## Category
- Chrome Web Store: **Productivity** (alt: Developer Tools)
- Firefox AMO: **Other** → tags: audio, productivity, education

## Detailed description

Waveform Viewer turns any audio on a web page into a real waveform you can look at,
compare, and measure — without downloading files into a desktop editor first.

It was built for language practice, where the whole point is comparing a model
recording against your own attempt, but it works anywhere audio plays: podcasts,
music tools, transcription apps, QA of your own site's audio.

WHAT IT DOES

• Draws a waveform for every audio clip the page loads, stacked as lanes in a
  floating panel you can drag, resize, and pop out into its own window.

• Shares one time scale across all lanes, so two recordings line up vertically and
  differences in pacing are obvious at a glance.

• One-click onset alignment shifts every lane so their first audible moment starts
  together. You can also drag any lane sideways to align it by hand, with the exact
  offset shown in milliseconds.

• Plays every lane together through a single synced playhead, so you hear the
  comparison instead of guessing. Mute or solo individual lanes while it plays.

• Drag across the waveform to measure any interval to the millisecond — the gap
  between two phrases, the length of a pause, how long a word takes.

• Download what you are looking at: the selected region as a WAV file, or the
  original audio file untouched.

• Pop the panel into a separate browser window and drag it to a second monitor,
  where waveforms fill the screen instead of hiding in a corner.

HOW IT FINDS AUDIO

Many players never create an <audio> element — they fetch the file and play it
through the Web Audio API, so simple extensions see nothing. Waveform Viewer
watches four independent routes: media elements (including detached ones),
decodeAudioData calls, fetch responses, and XMLHttpRequest responses. A status
line shows exactly what was detected, so when a page uses something exotic you can
see why rather than being left with a blank panel.

PRIVACY

No accounts, no servers, no analytics, no tracking. Audio is decoded locally in
your browser and nothing ever leaves your machine. The extension makes no network
requests of its own beyond re-reading the audio files the page already loaded.

Open source under the MIT license.

## Permission justifications (Chrome Web Store review form)

**storage**
Stores two things locally: whether the extension is enabled, and the panel's last
window position and size. No user content and no browsing data is stored.

**host permissions (<all_urls>)**
The extension's single purpose is to visualise audio on whatever page the user is
currently on, and the user chooses that page — it cannot be predicted or limited to
a fixed list of sites. Two things need the permission:
(1) the content script must be present at document_start on any page so it can
observe the audio the page loads, and
(2) audio files are frequently served from a CDN on a different origin with no CORS
headers, so re-reading those bytes for waveform rendering must happen from the
extension's background context.
The extension reads only audio the page has already loaded. It does not read page
content, form data, cookies, or browsing history, and it transmits nothing.

**Remote code**: none. All code is contained in the package. No eval, no remotely
hosted scripts, no external libraries.

**Data collected**: none. Please select "does not collect user data".
