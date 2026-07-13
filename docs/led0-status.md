# LED 0 status indicator

LED 0 (the first pixel in the chain) doubles as a **status light** and the
device's **boot-time diagnostic channel**. With no screen, and a user who often
can't attach USB or an app, the one thing they *can* do is read you the first
LED: "it's pulsing blue," "cyan then two yellow blinks." So LED 0 has to say, at a
glance for the common cases and by a short readable code for a boot failure, *what
the device is doing or what went wrong*.

**Only LED 0 — never the whole strip — carries status or errors.** A failed
device with a dark strip just looks like it *hasn't started yet* to a bystander;
only someone who leans in and checks LED 0 learns more. Lighting the whole strip
to announce a failure would be conspicuous, embarrassing, and awkward in the room
the device is installed in. Discretion is the point.

**LED 0 is a break-glass diagnostic, not a status monitor.** Confirmed on hardware
(2026-07-12): boot completes and the pattern starts in well under a second, and in
an installed lamp the first pixel is physically hard to single out — so the
*success-path* boot sequence (the stage colors, the green "boot complete" flash) is
practically **unobservable** in normal use, and that's fine. LED 0's real payoff is
the **failure** case, where the device **halts on a steady error pattern** you can
walk up to and read at leisure. So: don't over-invest in success-path indicators
(the stage colors earn their keep only as the *frozen* color when boot halts at a
stage); the effort belongs in making the halt states clear, discreet, and readable.

Reference implementation: [`web/src/export/rp2040.ts`](../web/src/export/rp2040.ts)
(`_STATUS` table, `_show_status`, `_set_overlay`, `_boot_stage`, `_boot_error`).
The Rust port mirrors it in [`firmware-rust/src/status.rs`](../firmware-rust/src/status.rs).
Colors/patterns carry **no protocol meaning** — they're purely local human
feedback, so they're safe to tune; keep the two firmwares in step with this doc.

## What LED 0 shows

1. **Ambient operational status** — a small set of ongoing, benign *runtime*
   states (a follower acquiring sync, an empty device). One unmistakable hue that
   pulses / blinks. Glanceable, no counting. *(These are not errors and not
   boot-scoped; they're the normal sync UX.)*
2. **Boot diagnostics** — a **stage indicator** while subsystems come up, and, if
   one fails, a **boot error code**: a subsystem color then a severity color
   blinked a small count. Errors are evaluated **only at boot**; there is no
   runtime error monitoring.

## Design rules

- **LED 0 only.** No whole-strip status or error signaling, ever. (Whole-strip is
  used *only* by the deliberate power-cycle recovery ritual — see below — where
  the user is intentionally watching and wants unmissable confirmation.)
- **Errors are boot-only.** A subsystem either comes up at boot or it doesn't;
  that verdict is what LED 0 reports. No "signal weak / connection lost later."
- **Severity encodes recoverability.** `red` = **fatal** (device won't run — an
  RMA; no user recovery path). `yellow` = **non-fatal** (device runs anyway; the
  user *can* fix it — in practice, Wi-Fi). `green` = boot completed OK.
- **Categorical colors, small counts.** Systems are cyan / blue / magenta;
  severity is green / yellow / red. A code's blink count is **1–4** — nobody
  should have to decide "was that 11 or 12, and was the gap 0.4 s or 0.6 s?"
- **Fixed visibility.** Status brightness is independent of master brightness, so
  it stays readable even at `BRIGHT 0`.
- **LED 0 returns to the animation** the moment normal playback runs; a leader or
  standalone device that is playing does **not** override LED 0 (except the
  single-pixel `searching` overlay).

## Ambient states

Ongoing runtime states, single hue, no counting.

| State | Color | Pattern | Scope | When |
|---|---|---|---|---|
| `acquiring` | blue | pulse | strip dark, LED 0 only | A follower has booted and is holding for its **first** beacon (never plays out of sync). Clears on lock. |
| `searching` | amber | blink | overlay on the animation | A running follower **lost** its leader and is free-running. The show keeps playing; LED 0 blinks amber until the leader returns. |
| `nofile` | red | pulse | strip dark, LED 0 only | Nothing is selected or the selection is gone. The device reads as alive-but-empty instead of dead. |
| `noprogram` | red | blink | strip dark, LED 0 only | A **follower** was told a program number it has **no `NN-` slice** for. Goes dark + red-blinks and keeps watching beacons — recovering the moment the group switches to a program it has, or the slice is uploaded. (Red like `nofile`, but *blink* vs *pulse*.) |

`OFF` (operator blanked the strip) is **fully dark** — distinct from `nofile`.
`acquiring`/`searching` are *pulses/blinks* of a lone hue, never the subsystem-beat
+ counted-blink shape of a boot error, so the two registers don't collide.

## Boot-stage indicator

While each blocking init step runs, LED 0 shows a **dim solid** stage color,
advancing on success. On a fast healthy boot these flick past in milliseconds and
LED 0 goes straight to playback. **If boot hangs, LED 0 is frozen on the stalled
stage's color** — and the palette matches the fault subsystems, so the frozen
color names the culprit:

| Stage | Color (dim, solid) |
|---|---|
| Filesystem / config mount | magenta |
| Radio (CYW43) bring-up | blue |
| Network bring-up (only if Wi-Fi is provisioned) | cyan |
| Boot complete → run loop | green (single brief flash) |

This is exactly the bug that cost a debugging cycle in the coex spike: an
unconfigured CYW43 hung with a dark strip. With this it reads as *frozen dim blue*
= "stuck in radio bring-up."

## Boot error code

If a stage *fails* (rather than hangs), LED 0 shows a repeating code. One cycle:

1. **Subsystem** color, solid **~700 ms** — *who failed*.
2. Gap, **~300 ms dark**.
3. **Severity** color, blinked **N times** (~250 ms on / 250 ms off) — *how bad*
   (red = dead / yellow = fixable), and *which* (the count).
4. **~1200 ms dark**, then repeat.

**Subsystems (field 1):** cyan = Wi-Fi, blue = Bluetooth/radio (CYW43),
magenta = internal/system (firmware, storage, config).
**Severity (field 2):** red = fatal (RMA), yellow = non-fatal (device still runs).

### Error table

| Code | Meaning | After |
|---|---|---|
| **blue · red ×1** | CYW43 radio not responding (SPI probe / power-on) | **halt** — strip dark, LED 0 code |
| **blue · red ×2** | Radio firmware / CLM / NVRAM load failed | halt |
| **blue · red ×3** | Bluetooth (HCI) init failed | halt |
| **magenta · red ×1** | Filesystem mount failed (littlefs) | halt |
| **magenta · red ×2** | Config corrupt / unreadable | halt |
| **magenta · red ×3** | Unexpected internal error at boot | halt |
| **cyan · yellow ×1** | Wi-Fi: wrong password / auth rejected | **runs on** — shown at boot, then LED 0 returns to normal |
| **cyan · yellow ×2** | Wi-Fi: saved network not found (out of range) | runs on |
| **cyan · yellow ×3** | Wi-Fi: joined but no IP (DHCP failed) | runs on |

**Fatal (red)** errors leave the device non-functional (no controllable radio, no
readable storage). There is **no user recovery** — the LED 0 code exists so the
code can be read back to *you* for triage before an RMA. The device stops with the
code showing on LED 0, strip otherwise dark.

**Non-fatal (yellow)** = **Wi-Fi only**. The device **moves past** it and runs
normally over BLE, standalone playback intact — Wi-Fi is auxiliary. The code is
shown briefly at boot so the owner learns "it's a Wi-Fi problem, and I can fix it"
(re-enter the password, check range), then LED 0 hands back to the animation /
ambient status. Wi-Fi state is also reported over the protocol (`WIFISTATUS` /
`INFO`) for the app, which is the real troubleshooting surface.

## Panic / crash

A crash must not just freeze silently. The panic path drives **LED 0 (only) in a
rapid red flutter (~10 Hz)** — far faster than any ~1 Hz status or code, so it's
unmistakably "the firmware crashed" and reportable as *fast red flashing on the
first LED*. (Rust: a custom `panic_handler` replacing `panic-halt`. MicroPython: the
top-level `try/except` around the main loop.) The rest of the strip stays dark.

## Recovery flashes (whole strip) — the one intentional exception

Fired at boot by the power-cycle recovery ritual (see
[`multi-device-sync.md`](multi-device-sync.md)). Unlike everything above, these
**do** use the whole strip — because the user is *deliberately* power-cycling and
staring at the device, and wants unmissable confirmation it registered. That's the
opposite situation from a failure you'd rather not broadcast, so the whole-strip
rule doesn't apply here.

Whether these light the whole strip or just LED 0 is a single **`RECOVERY_WHOLE_STRIP`**
flag in each firmware (default whole-strip), so it's a one-line change if that call
is revisited.

| Event | Color | Meaning |
|---|---|---|
| *progress* | dim white | Each counted reset from the **2nd** on lights that many pixels (1 per count) — immediate "it registered / you're at N" feedback while cycling. `n == 1` stays silent (looks like a normal boot). |
| `pin-cleared` | cyan | The 5th interrupted boot **cleared the PIN** (kept group + Wi-Fi) — the forgotten-PIN escape hatch. Fumbled? Let it boot once and the count clears. |
| `factory-reset` | magenta | The 10th interrupted boot **full-reset**: de-grouped + cleared Wi-Fi + cleared the PIN. Reached by continuing straight from 5 to 10. |

## Colour reuse — why it isn't ambiguous

Scope + pattern + timing keep the shared hues apart; none carry protocol meaning:

- **blue** — `acquiring` (lone gentle *pulse*) vs radio *boot stage* (dim solid) vs
  radio *error* (solid beat then counted red blinks).
- **red** — `nofile`/`noprogram` (a lone *pulse*/*blink*) vs an error *severity*
  (counted, always preceded by a subsystem beat) vs *panic* (fast ~10 Hz flutter).
- **cyan / magenta** — brief *whole-strip* recovery flashes during a deliberate
  power-cycle vs *LED-0-only* subsystem beats in a boot error code.

## Strip length is never tracked for status

A device only knows its strip length from the pattern file, which may be missing,
corrupt, or (for a follower) a program it doesn't have. Rather than track a "last
known length," the **boot-clear** and any **whole-strip recovery flash** simply
write a fixed **1000 LEDs** (`STATUS_BLANK_LEDS`): the target pixels show, the rest
go black. This clears power-on garbage *and* any previous longer pattern's tail
with no bookkeeping. Overshooting a shorter strip is harmless — the extra data
falls off the end of the WS2812 chain. It's ~30 ms of shift-out, but DMA-driven, so
the CPU stays free for BLE/Wi-Fi. (Actual playback always uses the real per-file LED
count; only these writes blank the max.)

## Notes

- Envelope/code timing is derived from the wall clock, so a shelf of devices in
  the same state (all `acquiring`, or all showing the same boot error) animates in
  rough unison — a lone off-phase or dark straggler stands out on its own.
