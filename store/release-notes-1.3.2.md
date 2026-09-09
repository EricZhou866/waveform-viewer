# AMO release notes — 1.3.2

Paste the section below into the **Release Notes** field when submitting the
version. 1.3.0 is already published, so this covers only what changed since it.
(1.3.1 was never submitted; its fix is included here.)

---

Two fixes to the on/off switch.

- **Turning the extension on no longer opens a panel in every open tab.** Only
  the tab whose toolbar button you clicked gets one. Other tabs show a panel
  when they actually have audio to draw, as they always did.
- **Off now means off.** With the extension switched off, a page opened
  afterwards is left completely alone — no panel, and none of the page's own
  code is touched. Previously the content script assumed the switch was on until
  the background confirmed otherwise, so audio playing in that first moment could
  put a panel on screen while the extension was supposed to be disabled.

Also: the tab you click the toolbar button in now always shows the panel, even
before any audio is found, so the status line at the bottom tells you what the
extension can see on that page. That line is the thing to look at when a page
plays audio but no waveform appears.
