# LED 0 status indicator

LED 0 (the first pixel in the chain) doubles as a **status light** in the states
where the strip isn't showing the real animation, or as a single-pixel overlay on
top of it. This lets a device communicate what it's doing with no screen and no
app — you glance at the first LED.

Implemented in [`web/src/export/rp2040.ts`](../web/src/export/rp2040.ts)
(`_STATUS` / `_RECOVERY` tables, `_show_status`, `_set_overlay`, `_flash_strip`).

## Design rules

- **Colors are unmistakable at a glance.** No counting blinks, no telling
  near-shades apart (light-red vs pink). Each state is a distinct hue.
- **Three patterns only:** `pulse` (breathe, ~1 Hz triangle), `blink` (on/off,
  ~1 Hz), `solid`.
- **Fixed visibility.** Status brightness is independent of master brightness, so
  it stays readable even at `BRIGHT 0`.
- **LED 0 returns to the animation** the moment normal playback resumes; a leader
  or standalone device that is playing does **not** override LED 0.

## States

| State | Color | Pattern | Scope | When |
|---|---|---|---|---|
| `acquiring` | blue | pulse | strip dark, LED 0 only | A follower has booted and is holding for its **first** beacon (never plays out of sync). Clears on lock. |
| `searching` | amber | blink | overlay on the animation | A running follower **lost** its leader and is free-running. The show keeps playing; LED 0 blinks amber until the leader returns. |
| `nofile` | red | pulse | strip dark, LED 0 only | Nothing is selected or the selection is gone. The device reads as alive-but-empty instead of dead. |

`OFF` (operator blanked the strip) is **fully dark** — deliberately distinct from
`nofile`.

## Recovery flashes (whole strip)

Fired at boot by the power-cycle recovery ritual (see
[`multi-device-sync.md`](multi-device-sync.md)). The **whole strip** flashes so
the feedback is unmissable while you're power-cycling, and the two thresholds are
different colors so you never have to count cycles:

| Event | Color | Meaning |
|---|---|---|
| `standalone` | white | The 5th interrupted boot **un-grouped** the device (kept Wi-Fi). |
| `wifi-cleared` | magenta | The 10th interrupted boot **also cleared** the Wi-Fi config. |

## Notes

- The envelope is derived from the wall clock (`time.ticks_ms`), so a group of
  followers all showing `acquiring` pulse roughly together — an off-phase or dark
  straggler stands out. (A future refinement could drive the envelope from the
  synced frame counter for exact-unison pulsing.)
- Colors/patterns here are intentionally easy to change — they carry no protocol
  meaning, they're purely local human feedback.
