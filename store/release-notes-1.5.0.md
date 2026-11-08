# Store release notes — 1.5.0

Both stores are on 1.4.3, so the two sections say the same thing. Paste the
matching one into the **Release Notes** field.

---

## Firefox / AMO (published version is 1.4.3)

One new setting: "Skip the first".

It cuts a fixed number of seconds off the front of every clip — the beep, the
count-in or the question prompt that plays before the audio you actually came
to look at. Anything from 0.5 to 10 seconds, in half-second steps. It is off by
default, so nothing changes until you turn it on.

The cut happens before the silent-ends trim, which is what makes it useful: the
pause between the beep and the speech goes with it, instead of being left behind
as dead space at the start of the waveform. A beep is sound, so a trim that ran
first would simply anchor itself to the beep.

Nothing is destroyed. Like the trim handles, this is a view of the clip — turn
the setting back down and the whole recording is there again, and no setting can
cut a clip away to nothing.

---

## Chrome Web Store (published version is 1.4.3)

One new setting: "Skip the first".

It cuts a fixed number of seconds off the front of every clip — the beep, the
count-in or the question prompt that plays before the audio you actually came
to look at. Anything from 0.5 to 10 seconds, in half-second steps. It is off by
default, so nothing changes until you turn it on.

The cut happens before the silent-ends trim, which is what makes it useful: the
pause between the beep and the speech goes with it, instead of being left behind
as dead space at the start of the waveform. A beep is sound, so a trim that ran
first would simply anchor itself to the beep.

Nothing is destroyed. Like the trim handles, this is a view of the clip — turn
the setting back down and the whole recording is there again, and no setting can
cut a clip away to nothing.
