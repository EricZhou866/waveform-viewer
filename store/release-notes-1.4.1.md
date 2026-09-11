# AMO release notes — 1.4.1

Paste the section below into the **Release Notes** field when submitting the
version. 1.3.0 is the published version, so this covers everything since it.
(1.3.1, 1.3.2 and 1.4.0 were never published; their changes are included here.
1.4.0 is not reusable as a version number — AMO reserves a version string for
good once it has been uploaded, even if the upload is deleted afterwards.)

---

**A clearer toolbar.** Every button is an icon now, with the action in its
tooltip. Play, open a file, and clear sit together at the front — the three
things you reach for most. Shift, lane height and Rescan have moved off the
toolbar; turn on **Show extra buttons** in Settings to bring them back.

The icons are also bigger and brighter, on the toolbar and on each lane. The
download, solo and mute buttons in particular were too small and too close to
the background to pick out at a glance.

**The panel gets out of the way.** Minimising it now shrinks it to a small bar
instead of leaving a full-width strip on the page, and a new ✕ on the title bar
closes the panel on that page entirely — it stops playing, clears its lanes, and
stays closed until you click the extension's toolbar button again.

**Two fixes to the on/off switch:**

- Turning the extension on no longer opens a panel in every open tab. Only the
  tab whose toolbar button you clicked gets one. Other tabs show a panel when
  they actually have audio to draw, as they always did.
- Off now means off. With the extension switched off, a page opened afterwards
  is left completely alone — no panel, and none of the page's own code is
  touched. Previously the content script assumed the switch was on until the
  background confirmed otherwise, so audio playing in that first moment could
  put a panel on screen while the extension was supposed to be disabled.

Also: the tab you click the toolbar button in now always shows the panel, even
before any audio is found, so the status line at the bottom tells you what the
extension can see on that page. That line is the thing to look at when a page
plays audio but no waveform appears.
