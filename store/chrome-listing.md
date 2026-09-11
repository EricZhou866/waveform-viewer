# Chrome Web Store — the answers the dashboard asks for

The **Privacy practices** tab is what holds up most submissions, and every box
on it has to be filled before "Submit for review" will go. Text below is meant
to be pasted as-is.

## Single purpose

> Draw a waveform for audio the current web page plays, so the user can compare
> two recordings side by side, align them, measure the gaps between sounds, and
> save a selection. Everything happens locally in the browser.

## Permission justifications

**`storage`**

> Stores the user's own settings (how many waveforms to show, minimum clip
> length, cropping strength), the panel's size and position, and the on/off
> state of the toolbar button. Nothing else is stored, and none of it leaves the
> browser.

**Host permission `<all_urls>`**

> The user decides which page they want to inspect, so the sites cannot be
> listed in advance — the extension has to be able to run wherever the user is
> playing audio. Two things need it. First, the content script must run at
> document_start to observe audio the page loads, including players that never
> create an <audio> element and instead decode the file through the Web Audio
> API. Second, audio is commonly served from a CDN with no CORS headers, and re-
> reading those bytes to draw and play the waveform is only possible from the
> extension's background context. The extension reads audio the page has already
> requested; it sends nothing anywhere.

**Remote code**: No. Everything executed ships inside the package — no eval, no
remote scripts, no bundled or minified third-party code.

## Data usage

Nothing is collected. Answer "No" to every data type, and certify that the
extension's use of data complies with the Developer Program Policies:

- No personally identifiable information, health, financial, authentication,
  personal communications, location, web history, or user activity is collected.
- Website content is read only as audio the page itself loaded, only in memory,
  only to draw a waveform, and never transmitted.
- No analytics, no accounts, no servers of the extension's own.

## Store listing

- **Category**: Workflow & Planning (or Education — the extension's audience is
  language-exam practice, and either is defensible; pick one and leave it alone,
  since changing it resets a listing's search standing).
- **Screenshots**: `store/screenshots/*.png`, already 1280x800, which is what the
  store wants. Regenerate them with `node store/make-screenshots.js` whenever the
  panel's look changes.
- **Description**: `store/listing-en.md`.
- **Privacy policy URL**: required for any extension with host permissions. The
  text is in `store/privacy-policy.md`; it has to be served at a public URL —
  GitHub Pages on this repo is enough.
