# Multi-device synchronized playback — design plan

Split one animation across multiple Pico W devices that play in sync, authored as
a single project and controlled as a single group from the phone.

## Why

A single LED chain hits a hard framerate ceiling: WS2812-style LEDs clock out at
~30 µs each, so ~1000 LEDs ≈ 30 ms just to shift a frame out — near 30 fps before
any compute. Past a few hundred to ~1000 LEDs you split the installation across
devices. The problem to solve is keeping those devices **in sync** while still
authoring and controlling the whole thing as one.

## Decisions (locked)

- **All devices are Pico W.** The W-vs-non-W price gap (~$3) is noise on a
  multi-thousand-LED install, and having BLE on every device removes a whole
  class of special-casing. No non-W followers.
- **Sync transport is BLE advertising beacons only.** GPIO strobe sync is
  **dropped** — if every device already talks BLE, a wired clock is extra code
  for no real-world benefit. (If a future install has serious RF-noise problems,
  e.g. a stadium, revisit then as a special case.)
- **BLE control is a conscious, warned fallback — Wi-Fi is preferred (revised
  2026-07-06).** The app **prefers Wi-Fi** for all control (program, brightness,
  pattern, role/group assignment) and **never silently falls back** to BLE. But
  BLE control **is** available as a deliberate action — the user has to tap a
  BT-marked item to use it. *Why the nuance:* on the Pico W a device advertising
  its beacon **stops advertising while a BLE central is connected** (measured
  2026-07-05 — re-confirm sometime, given the ~20 ms→~1 ms beacon surprise), so a
  BLE session on a **group leader pauses its beacon for the connection's
  duration**. Followers free-run through that gap and re-lock instantly (validated
  ±0.05–0.7 frame), and the firmware **resumes advertising on disconnect** (the
  `_IRQ_DISCONNECT` re-advertise), so the pause is bounded and self-healing.
  Therefore: when the user intentionally connects over BLE to a device the app
  knows is a **group leader**, show a warning that **the group will pause for the
  duration**. Standalone devices and followers are unaffected (they don't beacon).
  This keeps a **no-reboot recovery path** for a leader whose Wi-Fi went bad
  (connect over BLE, fix Wi-Fi) without the power-cycle ritual. Purely app-side —
  the firmware already supports BLE control + resume-on-disconnect.
- **Recovery is a power-cycle ritual (no boot delay).** To rescue a device whose
  AP vanished (WiFi points at a ghost, BT is busy syncing): **5 interrupted
  power-cycles → standalone** (un-group, keep WiFi); **10 → also clear WiFi
  config**. Mechanism: bump a flash counter **very early in boot** (before BLE, so
  it sticks even if init hangs); the pattern plays **instantly** every boot; once
  the device has run ~5 s ("commit") the counter resets to 0 — so a normal single
  glitch never counts. The criterion is simply *"did you let it run past the
  commit window before pulling power."* The action fires **at the threshold boot
  itself**: the 5th short boot comes up standalone and **flashes the strip**; a
  10th also clears WiFi; only the ~5 s commit resets the counter, so 5 vs 10 stay
  distinguishable and you get immediate "keep cycling until it flashes" feedback.
  File ops are trivial (~tens of ms); 5-minimum guards against accidental
  double-boots. A one-drag "recovery UF2" (forces standalone) is the ultimate
  backstop.
- **Reboot = straight back to work, no recovery period.** A device boots directly
  into its saved role and starts its pattern immediately. A follower free-runs
  its pattern at once and scans for its leader in the *background*, locking on
  when it hears the beacon (no "search then fall back to standalone" delay — the
  power-cycle ritual is the deliberate exit).
- **Sync clocks, not frames.** The runtime is a deterministic fixed-rate loop, so
  devices only need to agree on *which frame index is now*. We fight jitter and
  drift, not latency; periodic beacons phase-lock free-running counters.

## REVISED model (2026-07-06) — roles in the file, auto-discovery, DMA runtime

This supersedes the pairing flow and the separate role.txt/GROUP config below; the
beacon wire format and the follower PLL are unchanged.

- **Role / group / device-id / timeline live in the `.leda` header, not separate
  config.** A device's role IS the file it's playing: **standalone**, **follower**,
  **leader+controller**, or **leader-only** — each header carries the device id +
  group id + numFrames + fps. Switching role = loading a different file. No
  role.txt, no pairing state. Per-device export already emits device-specific files,
  so it just stamps role/group/id into each header.
- **leader-only = a header-only `.leda`** (numFrames + fps + role + group, *no* pixel
  data). Same load-and-run code path — it runs the master clock + beacon and skips
  the strip. **leader+controller** is the identical path *with* real pixel data
  (drives its strip AND beacons).
- **Followers auto-discover their leader by group id — no manual pairing.** "Hear a
  group-X beacon → sync to it." Different installations use different group ids to
  avoid cross-sync. Hobby-grade trust (a rogue group-X beacon would be obeyed —
  optional `AUTH` later); two leaders on one group is a misconfig (tie-break by
  seq/signal, or just document "don't").
- **Followers stay app-reachable over Wi-Fi** for management (status, file upload,
  config) — receiving the beacon is a cheap BLE interrupt and the DMA/viper player
  frees the CPU, so a follower syncs AND serves the app. Live *animation* switching
  is a group action (leader's program #); per-device file management is individual.

### Show vs installation, and the follower lifecycle (2026-07-06)

- **Program # = which show; group id = which installation.** Switching shows is a
  **program-# change** broadcast in the beacon (jukebox — each device loads its own
  `NN-*.leda` slice); it never changes the group. **Group id is a per-installation
  value the editor manages** (assigned once, stamped identically into every program's
  files for that installation), so a designer never hand-picks group ids per file and
  switching shows can't accidentally orphan the group. Changing the group id = a
  deliberate repurposing of the devices, not a show switch.
- **A follower keeps playing unless it gets an EXPLICIT stop.** The only stops are:
  (a) a **graceful teardown** — the leader was deliberately switched off leader duty,
  so it broadcasts the teardown flag → followers stop (orphan / LED-0); or (b) an
  **operator command** (app). Everything else keeps playing:
  - Leader **crashes / BT jammed** (no teardown ever arrives) → followers **free-run**
    and re-lock if it returns. Since they were all last corrected by the same beacon,
    they stay coherent with each other for a long time (drift is tens of ppm →
    seconds/hour). The show does not die on an ungraceful loss.
  - **No reboot-search-timeout / standalone fallback** — that branch is removed.
- **Reboot behavior is role-driven.** Standalone / leader / leader-only files
  **play (and beacon) immediately** on boot — they are the reference. A **follower**
  file **holds (dark / "acquiring" indicator) until its first beacon, then starts
  already in sync** — never a visible catch-up snap. A whole-system power glitch thus
  resolves to a sub-second dark then clean synced playback. Corner: a fresh follower
  reboot with the leader genuinely absent sits in the acquiring indicator until a
  beacon appears (never plays out of sync, never looks dead) — a *running* follower
  never does this, only a boot with no reference.
- **No firmware/beacon misconfig guards.** A mismatched program file (wrong content,
  wrong LED count, wrong group) is visible on the strip and diagnosable in the app
  (which knows what it uploaded where) — not worth protocol weight. Keeps the beacon
  at ~27/31 bytes.

## Runtime & performance (2026-07-06)

- **DMA-fed PIO for WS2812, on every device.** The PIO clocks the strip out
  independently; DMA feeds it from a RAM buffer with ZERO CPU during the
  ~30 ms/1000-LED shift-out (double-buffer: fill next while current streams). Buffer
  prep (flash read + brightness scale + GRB reorder) in `@micropython.viper` (native,
  ~ms). This is the right architecture regardless of sync — smoother standalone,
  higher ceiling, less CPU heat.
- **Because the CPU is free during shift-out, the ~20 ms beacon stall hides in that
  idle window** → **leader+controller is viable for modest strips on ONE core**
  (rough: ~several hundred LEDs @30 fps, ~1000 @15 fps), no custom firmware. BLE
  (CYW43/SPI) and the LED pin (PIO/DMA) are separate hardware, so they overlap.
- **Sleep the remainder, not a fixed delay (DONE 2026-07-06).** The player loop sleeps
  `period − elapsed` (was a fixed `base_delay` on top of the work), so jitter incl.
  the beacon is absorbed within budget and actual fps holds at nominal.
- **Auto-scale fps to strip length.** Max fps is bounded by shift-out (~30 µs/LED) +
  prep; cap the authored fps per strip (build on `ws2812MaxFps`/device profiles). For
  a sync group, group fps = the slowest (longest) device's ceiling — all share one
  timeline.
- **~500-LED soft limit in the editor** → nudge to split across devices (trivial now:
  per-LED device ids + per-device export). Dedicated leader only forced near the
  ~1000-LED single-device ceiling.
- **Optional, later: core-1 renderer** for max single-device performance — needs a C
  module that releases the GIL, or a custom-firmware core-1 loop (a bespoke UF2).
  `_thread`/viper alone share the GIL, so no free parallelism there. Back-pocket
  once DMA+viper is in.

## Status & decisions (2026-07-06)

Ratified decisions (supersede the earlier-model sections below):

1. **The `.leda` header is the single source of truth for role / group / device-id.**
   No `role.txt` / `group.txt`, no pairing state. Changing a device's role = loading
   a different file. `ROLE` / `GROUP` / `DEVICE` are **read-only** report commands.
2. **`PROGRAM <n>` is the group jukebox verb** — a leader loads its own `NN` slice and
   stamps `n` into the beacon; followers hear it and load their own `NN` slice.
   Program # is the file's `NN-` name prefix, not a header field.
3. **`TEARDOWN` is best-effort** — the leader broadcasts the teardown flag for ~2 s
   then silences the beacon; an operator stop over Wi-Fi mops up any straggler.
4. **A follower trusts its own header's fps/numFrames** — no auto-detection (unlike the
   Pi bench rig, which had no file). The PLL only phase-locks + trims rate.
5. **On a program-# change a follower hard-seeks** — reload the slice, jump to the
   beacon frame (the PLL's big-jump branch). No crossfade.

Group id is **1 byte** (0–255), matching the on-air beacon; the "4 bytes" in the old
draft table below is superseded.

### What's built & hardware-validated (Pico W, MicroPython 1.28)

- **DMA-fed PIO WS2812 player + viper buffer prep.** ~30 µs/LED shift-out costs zero
  CPU; a 200-LED leader frame (incl. beacon) peaks at **1.7 ms** work vs a 33 ms
  budget. The `gap_advertise` stop/start is only **~1 ms** (not the ~20 ms the
  pre-DMA player suffered) — so **leader+controller holds nominal fps on one core**
  for modest strips, with large headroom. Core-1 stays a back-pocket item.
- **Header roles + `PROGRAM`/`TEARDOWN`/read-only `ROLE`/`GROUP`/`DEVICE`** — verified
  over Wi-Fi/TCP (`PROGRAM 7` loads the follower slice; the firmware re-reads role/
  group/device from its header).
- **BLE coexistence** — a device can `gap_scan` for beacons **while** running the DMA
  player at 30 fps **and** advertising device-info + serving GATT. So a follower stays
  fully app-discoverable/provisionable while it syncs.

### Follower — VALIDATED on hardware (2026-07-06)

The follower PLL is ported, and after fixing a **CYW43 radio bring-up clash** (the
first run hard-faulted the board — a continuous BLE scan started at the same moment
as the Wi-Fi station bring-up), it **locks cleanly**: Pico follower ← Pi leader holds
`locked=True` at **±0.05–0.7 frame** drift with the rate tracking the leader (~30.0
fps). The fix: the follower starts scanning **only after Wi-Fi has settled**
(`_follower_start_scan`), at low duty; plus hardening (no `import` in the scan IRQ,
`_show_grb` short-read guard). Boot order confirmed: Wi-Fi connects, *then* the scan
starts, no hang. See [`led0-status.md`](led0-status.md) for the acquiring/searching
indicators. Whole multi-device sync path is now proven end-to-end on real firmware.

## Core concepts (earlier model — see REVISED above)

### Roles

Each device is configured as one of:

- **standalone** — normal single-device behavior (today's behavior).
- **leader** — clock/state source for a group; the only phone-controllable device
  once a group is paired.
- **follower** — mirrors a leader; after lock-in it is listen-only.

Role is **decoupled from device ID.** The leader can be any device (pick the most
physically central one); it does not have to be device 0.

### Device ID (render slice)

A per-LED `device` id says which device renders each LED. One project describes
the whole installation; per-device export produces each device's **slice**. Same
animation, same frame count/rate, different bytes per device.

`bakeProject` already samples per-LED and `compactRaster` already partitions
columns, so per-device export is the same partitioning keyed on `device`.

### Program number (shared selection id)

Each pattern gets a **program number** (user-assigned, like LED numbers). It is a
flexible tag, not a rigid slot: arbitrary storage order, gaps allowed. It is the
1-byte id the group uses to select a pattern.

- Stored as a **filename prefix** the firmware parses (`07-rainbow.bin`), so we
  index by number without a manifest and don't constrain the rest of the name.
- The *same program number* on different devices maps to *that device's slice* of
  the same program. "Play program 7" → every device plays its own slice 7.
- Invariant: all slices of one program share frame count + frame rate (guaranteed
  because they come from one bake).

Numbering is useful even single-device (a stable id to select among loaded
programs), so it's not multi-device-only overhead.

### Group id

A group id (the leader's identity) is carried in the beacon. Followers **bind to a
group**, so multiple installations in the same space don't cross-sync, and a
rebooted follower rejoins *its* group rather than a stranger's.

## Sync beacon

The leader broadcasts its authoritative **state** (not just a clock) in a BLE
advertisement's manufacturer data, a few Hz. Followers mirror it. Legacy adverts
give ~24 usable bytes; the payload is well under that.

Payload (draft):

| field         | bytes | notes                                            |
|---------------|-------|--------------------------------------------------|
| group id      | 4     | leader identity; followers filter on this        |
| frame index   | 4     | current frame in the loop                        |
| timestamp     | 4     | leader clock at broadcast, for phase-lock        |
| program #     | 1     | which program the group is playing               |
| brightness    | 1     | 0–255                                            |
| flags         | 1     | play/pause, teardown, pairing-mode, …            |
| seq / version | 1     | detect stale/duplicate adverts                   |

Because the beacon carries program/brightness/flags, changing the pattern or
brightness on the leader propagates to the whole group **with no upload** — this
is the live "jukebox" behavior.

The leader can advertise while connected to the phone (BLE) **and** while on WiFi,
so the system works with or without WiFi.

## Follower state machine

- **Discover:** a follower (role from its file header) **auto-discovers** its leader
  by group id — "hear a group-X beacon → lock to it." No manual pairing.
- **Phase-lock:** on each beacon, predict the leader's current frame (beacon frame +
  rate × age) and nudge a free-running counter's phase + rate (a small PLL). Free-run
  between beacons. Drift is tens of ppm, so a beacon every ~0.1–1 s is plenty. The
  follower stays Wi-Fi-controllable throughout (scan + Wi-Fi coexist on the CYW43).
- **Teardown:** leader broadcasts the teardown flag → followers **stop** (go dark) and
  await an operator command; they remain individually reachable over Wi-Fi.

### Failure / reboot behavior (see the REVISED model — no timeout)

Role + group come from the played file's header, so nothing extra is persisted.

- **Rebooted follower:** holds **dark** (LED0 `acquiring`) until its first beacon,
  then starts already in sync — never a visible catch-up snap, never a standalone
  fallback. (The old "search N seconds → standalone" branch is **removed**.)
- **Running follower, leader vanishes:** keeps free-running (LED0 `searching`
  overlay) and re-locks when the leader returns. The only stops are an explicit
  operator command or a graceful `TEARDOWN`.

## Status indicator (LED 0)

Auto-discovery replaced manual pairing, so there is no "pairing mode." LED 0 is a
general status light — `acquiring` / `searching` / `nofile` and the whole-strip
recovery flashes — specified in **[`led0-status.md`](led0-status.md)**.

## Workflows

**Author → deploy**
1. Author one project; assign each LED a `device` id.
2. Assign each pattern a program number.
3. Per-device export → one slice per device per program.
4. Upload each device's slice to that device (batch or individual), tagged with
   the program number. **Uploads require individual reachability — do this before
   pairing, or after a teardown.**
5. Set each device's device id and role. Choose the leader.
6. Enter pairing mode; followers discover and bind to the leader; confirm sync via
   the LED-0 indicator.

**Run**
- Leader is the only phone-controllable device. Selecting a different program or
  brightness on the leader broadcasts to the group instantly (no upload).

**Change / add programs**
- Switching among already-loaded programs: live, via beacon program #.
- Loading new/replacement programs: teardown → upload to each device → re-pair.

## Consistency check

A device told to play a program it doesn't have will silently do nothing / desync.
The app knows what it uploaded where, so at setup it should **verify every device
has every program number it might be told to play, with matching frame counts**,
and surface mismatches in group status ("device 3 is missing program 7").

## App (iOS) changes

- Assign device id + role per device (while individually reachable).
- Discover leaders; pick one to follow; drive pairing.
- **Group representation:** after lock-in, followers drop off the individually
  controllable list — show the leader with its followers as one unit, with sync
  status mirroring the LED-0 indicator.
- Batch upload (iterate group devices, send each its slice); individual upload as
  fallback.
- Consistency check + mismatch warnings.

## Web editor changes (transport-agnostic foundation — start here) — DONE

These are useful on their own and everything else builds on them:

1. **Per-LED `device` id** — DONE. New optional `device?: number` on
   `LedPosition` (default 0), alongside `disabled` / `unassigned` / `animIndex`.
   Edited via a **Device** field in the Inspector; a **Device** option in the
   viewport Numbers dropdown billboards each LED's device id (cyan pill).
2. **Per-device export** — DONE. `partitionByDevice(raster, leds)` in `bake.ts`
   generalizes `compactRaster`: drops unassigned LEDs, groups the rest by device
   id (chain order preserved), returns one `{device, raster}` per device (always
   ≥1, device 0 for a single-device project). The Export dialog delivers **one
   bundle per format**: single device → today's single file; multiple →
   `.leda` → a `.zip` of per-device slices; MicroPython → one `.zip` with
   `device-N/` subfolders; UF2 → a `.zip` of per-device `.uf2` files.
3. **Program number per pattern** — DONE. Project-level `program` (0–255, default
   1), edited in the Export dialog, persisted in the project file. Drives the
   zero-padded filename prefix (`07-name.leda`). The firmware will index by the
   numeric prefix.

**Also decided while building (2026-07-05):** per-board settings (data pin /
device name / brightness) are **per-device** — the Export dialog shows one
settings block per device, persisted in the project file as
`ProjectFile.devices` (keyed by device id). Device name defaults to the project
name; pin 0; brightness 100%.

- **Set-all toggle:** a "Same pin & brightness for all" checkbox (multi-device
  only) bakes shared pin/brightness into every device (persisted as
  `ProjectFile.deviceDefaults` = `{uniform,pin,brightness}`); names stay
  per-device. In set-all mode the per-device frames show only the name (no
  per-device size — the "Largest slice" stat covers it); in per-device mode each
  frame shows its slice size.
- **Manifest:** every multi-device bundle (UF2 zip / MicroPython zip / .leda zip)
  includes a root `manifest.txt` mapping device number → device name →
  file/folder → LED count + size, so the user knows which artifact goes to which
  named board (e.g. "Northeast corner = device 3 = 07-name-dev3.uf2").
- **Condensed the export README** (`rp2040Readme`) to purpose + per-file
  descriptions + target device; dropped the protocol/UUID/LEDA-format dump.
  `networks.txt`/`state.txt` are listed as runtime-generated, and it flags that
  the Wi-Fi password in `networks.txt` is plaintext.

## Firmware changes

- **DONE** — DMA+viper player; role/group/device read from the `.leda` header;
  program library by `NN-` filename prefix; leader beacon; `PROGRAM`/`TEARDOWN`;
  read-only `ROLE`/`GROUP`/`DEVICE`; LED-0 status (`led0-status.md`).
- **DONE (code) / NEEDS RETEST** — follower scan + PLL phase-lock + apply state
  (program/brightness/play/teardown), hold-dark-until-first-beacon, no timeout.
  Hung the board on first run (CYW43 bring-up clash hypothesis); scan now
  sequenced after Wi-Fi. See "Follower — implemented, NOT yet validated" above.
- **TODO** — role-assignment export UI (which device is leader / leader-only, and
  the installation group id) + stamping it into headers; power-cycle recovery
  ritual (5→standalone, 10→clear Wi-Fi) with the recovery flashes.

## Explicitly out of scope

- **GPIO wired sync** — dropped; BLE covers it.
- **Non-W followers** — dropped; all devices are Pico W.
- **Heavy RF-robustness work** (stadium-scale noise) — revisit only if a real
  install needs it.

## To validate on hardware

- ~~BLE scan + advertise + GATT + DMA-player coexistence on one Pico W.~~
  **DONE (2026-07-06)** — all coexist at 30 fps; beacons received while playing.
- **Follower integrated run** — the outstanding one: retest after the scan-after-
  Wi-Fi fix (the first attempt hard-faulted the board). Power-cycle → flash → run a
  follower file against a group-matched leader (the Pi `~/ledrig/leader_headless.py`
  is a ready bench leader).
- Beacon cadence vs. phase-lock tightness with the *firmware* follower (the Pi
  bench follower already showed ±0.2–0.5 frame).

## Suggested implementation order

1. ~~Web foundation (per-LED device id, per-device export, program #).~~ **DONE.**
2. ~~Firmware: DMA+viper player; program library; header roles; leader beacon;
   PROGRAM/TEARDOWN; LED-0 status.~~ **DONE (2026-07-06).**
3. **Firmware: follower scan + phase-lock — retest & finish** (code committed, hung
   on first run; fix applied, needs on-device confirmation).
4. Web: role-assignment export UI (leader / leader-only / follower per device) +
   installation group id, stamped into headers.
5. Firmware: power-cycle recovery ritual (5→standalone, 10→clear Wi-Fi) + flashes.
6. iOS/macOS: group view, batch upload, consistency check, provisioning-only BLE.
