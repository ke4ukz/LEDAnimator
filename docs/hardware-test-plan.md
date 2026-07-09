# Hardware test plan — multi-device

What still needs **real multi-device hardware** to validate. Almost every
single-device path is already proven on one Pico W + the bench Pi (a raw-HCI BLE
beacon); the items below need **2+ Pico W** (a plain non-W Pico has no radio and
can't participate; a full Pi with Bluetooth is a raw-HCI stand-in that can be a
second *leader* but can't run the MicroPython election firmware). Written 2026-07-07.

## Setup / how to run

- **Bench Pi leader:** `~/ledrig/leader_headless.py <group> <fps> <numframes> <program>`
  (raw HCI USER channel; BLE prep = `sudo systemctl stop bluetooth` + clear rfkill soft
  via sysfs + `hciconfig hci0 down`; kill any stale proc holding hci0). SSH: inline the
  command, don't store it in a var (zsh won't word-split it).
- **Generate firmware:** `cd web && npx tsx gen-firmware.ts /tmp/leda_main.py && python3 -m py_compile /tmp/leda_main.py`
  — **confirm it printed `wrote … chars`** (a stray backtick silently yields a stale file).
- **Flash:** `mpremote cp /tmp/leda_main.py :main.py && mpremote reset`. Iterate from RAM
  with `mpremote run /tmp/leda_main.py` — but a firmware *hang* there needs a physical
  power-cycle to recover.
- The `dev+test` gen build prints follower/election diagnostics (`FOLLOWER LOOP`,
  `election …`, `bound to leader …`, `LOST/RE-ACQUIRED`); web exports never include them.

## Already validated (1 Pico W + Pi)

DMA+viper player · header roles · `PROGRAM`/`TEARDOWN` + read-only `ROLE`/`GROUP`/
`DEVICE` · follower PLL lock (±0.05–0.7 frame) · scan+advertise+GATT+Wi-Fi coexistence ·
on-loss policy *read* · startup policy (wait / start-and-go, both ways) · auto-election
*decision* (promote on silence / follow on a beacon) · sticky-bind to a real leader MAC ·
leader commit + stop-listening after the window.

## Needs real hardware

### A. Sync fundamentals (2 Pico W)
- [ ] Two Pico W hold **visual sync over time** — the real "do they stay locked" test
  (watch drift over minutes/hours).
- [ ] **Leader + controller** drives its own strip *and* coordinates followers, all in
  sync (the leader's slice included).
- [ ] **Program change (jukebox):** leader `PROGRAM n` → every follower switches its
  `NN-*.leda` slice and stays synced.
- [ ] **Graceful teardown:** leader `TEARDOWN` → followers actually stop (the flag-
  reception path; couldn't force cleanly on the Pi bench).
- [ ] **Fixed-leader** export mode drives a real group.

### B. Auto-election & leader lifecycle (2–3 Pico W)
- [ ] **Lower-MAC step-down FIRES** — a leader hears a lower-MAC rival inside its ~3 s
  commit window → steps down to follower. *(Can pre-check now with a spoofed-low-MAC Pi
  beacon + a temporarily-lengthened commit window.)*
- [ ] **Commit holds** — a rival appearing *after* the window does NOT usurp the running
  leader.
- [ ] **Simultaneous-boot backoff** — two `auto` devices powered on together resolve to
  exactly one leader (the other follows). **2 Pico W only** — a Pi can't run the election.
- [ ] **Returning leader defers** — reboot an ex-leader while another leader exists → it
  comes up a follower.
- [ ] **Sticky binding ignores a concurrent 2nd leader** — a follower bound to leader A
  is not pulled by leader B on the same group (needs 3 BLE devices).
- [ ] **Un-bind + re-acquire** — the bound leader goes silent > 2.5 s → the follower
  un-binds and locks to a different leader.

### C. Loss & recovery
- [ ] **LOST → blackout / silent / indicate** on a *true* beacon absence (leader powered
  off / out of range). **Couldn't force on the Pi bench** — its radio keeps broadcasting
  the last advert, so the follower just extrapolates. Needs a leader that truly stops
  (power off a 2nd Pico W).
- [ ] **Start-and-go convergence** — several lamps boot alone (start-and-go), then
  visibly sync up when they hear each other (the "impressive to watch" scenario).
- [x] **Power-cycle recovery ritual** — ✅ 2026-07-08, fully validated with a real `RUN`-pin
  button: **5× cyan** clears the PIN (`auth.txt`, keeps group + Wi-Fi); **10× magenta** does the
  full reset (de-group + clear Wi-Fi + PIN — confirmed by the Pico dropping off Wi-Fi, needing
  `networks.txt` re-sent). Count commits (resets) the instant the boot reaches the animation, so
  the reliable rule is "let it come up, then press again." Wire a momentary button from `RUN`
  (pin 30) to GND; no debounce needed.
- [x] **Missing-program status** — ✅ 2026-07-08: leader on a program the follower lacks →
  follower reports that program #, keeps its old file, shows red `noprogram` (blink) on LED 0;
  recovers automatically when the leader returns to a program it has.

### D. Export end-to-end
- [ ] **Multi-device export → deploy** — export a real multi-device project (group /
  leader-mode / on-loss / startup), flash each Pico W its slice, confirm the whole
  installation plays synced with the configured roles.
- [ ] **Enabled-state → standalone** — disable all-but-one strip, export, confirm the
  lone device plays as plain standalone (even if its device id ≠ 0).
- [ ] **Dedicated leader-only** (once built) — a no-strip coordinator beacons and a
  follower locks to it.

### E. BLE control coexistence
- [ ] **Does a leader's beacon pause while a BLE central is connected?** Connect nRF /
  the app to a leader while a follower is locked, and watch whether the follower loses
  sync for the connection's duration. Informs the warned-BLE-control model — the "pauses
  while connected" behavior may be an artifact, like the ~20 ms→~1 ms beacon was. (Needs
  only 1 Pico W + a phone/nRF + the bench Pi as follower-observer, so doable soon.)

## Related

- [`multi-device-sync.md`](multi-device-sync.md) — the design + what's built.
- [`led0-status.md`](led0-status.md) · [`file-format.md`](file-format.md) ·
  [`protocol.md`](protocol.md) · [`sync-beacon.md`](sync-beacon.md).
