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
| `noprogram` | red | blink | strip dark, LED 0 only | A **follower** was told (via the beacon) a program number it has **no `NN-` slice** for. Rather than silently play its stale slice, it goes dark + red-blinks and keeps watching beacons — recovering the moment the group switches to a program it has, or the missing slice is uploaded. (Red like `nofile`, but *blink* vs *pulse*, since both are "can't play right now.") |

`OFF` (operator blanked the strip) is **fully dark** — deliberately distinct from
`nofile`.

## Recovery flashes (whole strip)

Fired at boot by the power-cycle recovery ritual (see
[`multi-device-sync.md`](multi-device-sync.md)). The **whole strip** flashes so
the feedback is unmissable while you're power-cycling, and the two thresholds are
different colors so you never have to count cycles:

| Event | Color | Meaning |
|---|---|---|
| *progress* | dim white | Each counted reset from the **2nd** on lights that many pixels (1 pixel per count), so you get immediate "it registered / you're at N" feedback while cycling. `n == 1` stays silent (looks like a normal boot). |
| `pin-cleared` | cyan | The 5th interrupted boot **cleared the PIN** (kept group + Wi-Fi) — the forgotten-PIN escape hatch. |
| `factory-reset` | magenta | The 10th interrupted boot **full-reset**: de-grouped + cleared Wi-Fi + cleared the PIN. |

*(Threshold model updated 2026-07-07 — "unlock at 5, full reset at 10." Build plan
in [`config-and-auth-plan.md`](config-and-auth-plan.md) §3. The old white
`standalone` / magenta `wifi-cleared` pair collapses into these two.)*

## Strip length is never tracked for status

A device only knows its strip length from the pattern file, which may be missing,
corrupt, or (for a follower) a program it doesn't have. Rather than track a "last
known length," the **boot-clear** and every **full-strip status/flash** state simply
write a fixed **1000 LEDs** (`STATUS_BLANK_LEDS`): LED 0 (or all, for a recovery
flash) shows the status, the rest go black. This clears power-on garbage *and* any
previous longer pattern's tail with no bookkeeping. Overshooting a shorter strip is
harmless — the extra data falls off the end of the WS2812 chain. It's ~30 ms of
shift-out, but DMA-driven, so the CPU stays free for BLE/Wi-Fi. (Actual playback
always uses the real per-file LED count — only these status writes blank the max.)

## Notes

- The envelope is derived from the wall clock (`time.ticks_ms`), so a group of
  followers all showing `acquiring` pulse roughly together — an off-phase or dark
  straggler stands out. (A future refinement could drive the envelope from the
  synced frame counter for exact-unison pulsing.)
- Colors/patterns here are intentionally easy to change — they carry no protocol
  meaning, they're purely local human feedback.
