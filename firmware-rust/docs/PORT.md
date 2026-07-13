# Rust firmware — port plan & status

A ground-up **Rust reimplementation** of the LED Animator device firmware,
currently a MicroPython program generated from a JS template
([`web/src/export/rp2040.ts`](../../web/src/export/rp2040.ts)). Kept as its own
crate for now; it will merge in — or, more likely, **replace** the Python — once
it reaches parity. Started 2026-07-09.

**Why Rust** (from [`docs/future-directions.md`](../../docs/future-directions.md) §2):
performance (native, no per-boot compile), robustness, and IP protection — a
compiled binary is a real deterrent vs. a plaintext `main.py`, and on the
**RP2350/Pico 2** it composes with secure boot for actual lockdown. The behaviour
and wire formats are frozen (see the protocol/format/sync-beacon docs), so this is
a **translation**, not a redesign — those docs are the language-agnostic contract.

## Status at a glance

| Piece | State | Module |
|---|---|---|
| Toolchain + embassy-rp skeleton | ✅ compiles + **flashed & running on the bench** | — |
| WS2812 output (PIO + DMA, variable length) | ✅ | [`ws2812.rs`](../src/ws2812.rs) |
| LEDA v1 format parse + fixed-rate player | ✅ (embedded test pattern) | [`leda.rs`](../src/leda.rs), [`main.rs`](../src/main.rs) |
| LED-0 status indicator (pulse/blink/solid) | ✅ core | [`status.rs`](../src/status.rs) |
| LED-0 boot diagnostics (stage indicator, boot-error codes, panic flutter) | ✅ framework (per [`docs/led0-status.md`](../../docs/led0-status.md)); error/recovery rows wired as subsystems land; **panic bit-bang HW-validated 2026-07-12** | [`status.rs`](../src/status.rs), [`panic.rs`](../src/panic.rs) |
| Master brightness scaling | ✅ (in `fill_grb`) | `leda.rs` |
| CYW43 bring-up (Wi-Fi+BT firmware, on-chip LED) | ✅ **in the real firmware, HW-validated 2026-07-13** (Phase D) | [`radio.rs`](../src/radio.rs) |
| **Wi-Fi + BLE COEXISTENCE** (the migration decider) | ✅ **bench-validated 2026-07-12** — Wi-Fi scan loop + trouble-host BLE advertise run concurrently on the one radio | spike-coex |
| Config files / littlefs on flash | ✅ **read + write HW-validated 2026-07-12** — reads `selected.txt`/`bright.txt` + plays the selected `.leda` from the real web-written fs; flash **writes persist across reboots** (proven with a boot-counter round-trip). `fs.read`/`fs.write`/`fs.remove` all work. | [`fs.rs`](../src/fs.rs), [`main.rs`](../src/main.rs) |
| Unified networking dep graph (cyw43+trouble+net+usb+littlefs) | ✅ **resolved + builds 2026-07-13** (Phase A; embassy main `9ae6c57`) | [`spike-graph/`](../spike-graph/) |
| Player migrated onto that graph (PIO1+DMA_CH2) | ✅ **HW-validated 2026-07-13** (Phase B) | `ws2812.rs`, `main.rs` |
| USB dev tooling: picotool reset iface + CDC serial logger | ✅ **HW-validated 2026-07-13** (Phase C) — `reboot -f -u` → BOOTSEL no button; serial log works | [`usb.rs`](../src/usb.rs) |
| State-driven player (Play/Solid/Off + live brightness/speed) | ✅ HW-validated 2026-07-13 | [`state.rs`](../src/state.rs), `main.rs` |
| Command dispatch (transport-agnostic) | ✅ core built (no-fs verbs + BOOTSEL) | [`protocol.rs`](../src/protocol.rs) |
| BLE control (advertise + NUS GATT + dispatch) | 🔬 **code done + advertising-validated**; live command round-trip pending a BLE central (see below) | [`ble.rs`](../src/ble.rs) |
| Wi-Fi auto-join + TCP :4550 control server | 🔬 **code done**; live join pending credentials (bench has no `networks.txt`) | [`wifi.rs`](../src/wifi.rs) |
| BOOTSEL protocol command (reboot to bootloader over the wire) | ✅ built (in dispatch) | [`protocol.rs`](../src/protocol.rs) |
| Wi-Fi provisioning + TCP :4550 + UDP discovery | 📋 planned | — |
| Multi-device sync (beacon + follower PLL) | 📋 planned | — |
| Auth PIN, power-cycle recovery ritual | 📋 planned | — |
| Power sensing (VSYS/USB) | 📋 planned | — |

The **player core is the done part** — the deterministic, real-time heart that
most benefits from Rust and maps cleanly. Everything networking is the large,
experimental remainder (below).

## Build / flash / test

The system `rustc`/`cargo` are Homebrew's (host-only); the cross target lives in
the **rustup** stable toolchain, so build through it:

```bash
cd firmware-rust
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo build --release
# -> target/thumbv6m-none-eabi/release/led-animator-fw   (ELF)
```

Flash while the Pico is in **BOOTSEL** (hold BOOTSEL while plugging in — there's no
software path back to BOOTSEL yet, see Gotchas):

```bash
~/.cargo/bin/elf2uf2-rs target/thumbv6m-none-eabi/release/led-animator-fw led-animator.uf2
picotool load -x led-animator.uf2        # -x = reboot into the app
# or straight from the ELF:  picotool load -x target/.../led-animator-fw
```

No debug probe on this bench, so **no RTT/defmt or `probe-rs run`** — the strip
itself (and later LED-0) is the only telemetry. `panic-halt` just stops on panic.

## Architecture

**embassy-rp (async)**, chosen over rp-hal because the CYW43 Wi-Fi/BLE driver
(`cyw43`) is embassy-native — committing to it now avoids a rewrite when
networking lands. The MicroPython player is one blocking fixed-rate loop; here the
player is an **async task** whose `ws.show(frame).await` yields to the executor
during the DMA shift-out — the async equivalent of the Python's "kick DMA, do
housekeeping during it, then sleep." Networking will be additional embassy tasks.

Key deps (pinned in `Cargo.toml` / `Cargo.lock`): `embassy-executor`,
`embassy-rp` (rp2040, time-driver, critical-section-impl), `embassy-time`,
`portable-atomic` (critical-section — M0+ has no atomic CAS), `static_cell`.

## Python → Rust mapping

| MicroPython (`rp2040.ts`) | Rust | Notes |
|---|---|---|
| PIO WS2812 asm + `_dma`/`_show_grb`/`_fill_grb` | `ws2812.rs` (`Ws2812`, `grb_word`) | Same GRB<<8 word; clock from `clk_sys_freq()` (RP2040↔RP2350 portable). `dma_push(&[u32])` takes a variable-length slice. |
| LEDA header parse + frame seek/read | `leda.rs` (`Pattern`, `Header`, `frame`) | Same 20-byte header + frame-major raster. |
| `_fill_grb` brightness scale | `leda.rs::fill_grb(_, _, bright)` | per-channel `c*bright/255`. |
| `_STATUS` / `_status_env` / `_show_status` | `status.rs` | pulse/blink/solid envelopes off the ms clock. |
| player loop (open/reload/render at fps) | `main.rs` | `Ticker` for fixed-rate; boot-clears the strip first. |

## Forward plan — the networking migration (next major phase, 2026-07-12)

Local storage (mount + read + **write**) is DONE and hardware-validated on the
player's **embassy-rp 0.4** (crates.io) graph. Everything networking (CYW43, BLE,
Wi‑Fi) needs the newer graph the **coex spike** proved. Decision: rather than bolt
USB/networking onto 0.4 and redo it, **migrate once** to the final graph and do USB
"right" there (the picotool reset interface + serial logging belong to this phase,
not a 0.4 hack). littlefs code ports as‑is (`embedded-storage` traits are stable).

### Phase A — Resolve ONE unified dependency graph (GATE) — ✅ DONE 2026-07-12
**RESOLVED.** Approach (b) won: a **newer embassy git rev**. On embassy main today
(`9ae6c574e20d6e21ab19f31575adbc4559f3d082`, 2026-07-12) cyw43 has moved to
**bt-hci 0.9** (matching trouble-host 0.7) and embassy-usb is on
**embedded-io-async 0.7.0** (matching cyw43 + bt-hci) — so the embedded-io skew
that broke USB on the old coex rev `1d3c3de` is **gone**. Pure crates.io (approach a)
is still blocked: published cyw43 0.7.0 pins `bt-hci ^0.8` while trouble-host 0.7.0
pins `^0.9` (no overlap) — only embassy's *git* cyw43 has caught up to 0.9.

The proven graph (spike lives at [`../spike-graph/`](../spike-graph/), builds
clean, 0 warnings, 371 KB ELF; recipe + version table in
[`spike-graph/STATUS.md`](../spike-graph/STATUS.md)):
- **`[patch.crates-io]` all embassy + cyw43 + cyw43-pio → embassy git rev
  `9ae6c574e20d6e21ab19f31575adbc4559f3d082`.**
- `trouble-host = "0.7"` + `bt-hci = "0.9"` from **crates.io** (they resolve to the
  same bt-hci 0.9.0 as cyw43 → `ExternalController::new(bt_device)` type-checks).
- `littlefs2` = ke4ukz fork rev `b008a1e`; littlefs2-sys(tinyrlibc) + delog(portable-atomic) crates.io.
- **API deltas vs the player's 0.4 graph** (Phase B must apply these): executor
  feature `platform-cortex-m` (not `arch-cortex-m`); `PioSpi::new` takes **two** DMA
  channels via `dma::Channel::new(ch, Irqs)`; cyw43 `Runner`/`SpiBus` gained the
  `Cyw43439` generic; DMA IRQs bind through `dma::InterruptHandler`. Exact call
  shapes are in [`spike-graph/src/main.rs`](../spike-graph/src/main.rs).
- Deliverable met: the spike stub wires cyw43 BT→trouble, embassy-usb-logger over
  the rp `usb::Driver`, embassy-net over the cyw43 net driver, and littlefs(fork)
  all in one crate. **Gate cleared — Phase B may start.**

### Phase B — Migrate the player crate onto that graph — ✅ DONE (HW-validated 2026-07-12)
Player crate moved onto the Phase-A graph (embassy git rev `9ae6c57`). Builds clean
(0 warnings), UF2 57.9 KB (≈ the 0.4 build). **Bench-validated 2026-07-12: green
boot flash then the selected `.leda` plays** — reads the real littlefs config and
drives GP0 via **PIO1 + DMA_CH2** on the new git-embassy HAL. Changes applied:
- `Cargo.toml`: deps → `platform-cortex-m` executor feat + all embassy patched to the git rev.
- `ws2812.rs`: struct field `PeripheralRef<AnyChannel>` → `dma::Channel<'d>`; ctor now
  `new<D: ChannelInstance>(common, sm, dma: Peri<D>, irq, pin: Peri<impl PioPin>)`
  building `dma::Channel::new(dma, irq)`; `show` → `dma_push(&mut self.dma, …)`.
  (Assembler body unchanged — `pio::program` re-export still present.)
- `main.rs`: **WS2812 moved to PIO1 + DMA_CH2** (PIO0 + DMA_CH0/CH1 reserved for the
  CYW43 PioSpi in Phase D, so WS2812 won't need re-validating then); `Irqs` now binds
  `PIO1_IRQ_0` + `DMA_IRQ_0 => dma::InterruptHandler<DMA_CH2>`; `Ws2812::new` gets `Irqs`.
- `fs.rs`, `panic.rs`, `leda.rs`, `status.rs`: **no changes needed** — `Flash`
  (`new_blocking`/`blocking_read`/`blocking_write`/`blocking_erase`), `Output::new`,
  and `Peripherals::steal()` are all API-stable across the move.

Validation target: reads the existing littlefs (`selected.txt`/`bright.txt`) and plays
the selected `.leda` on GP0 — now via PIO1/CH2. Once the strip confirms → Phase B DONE.

Original delta notes (the same ones that hit porting the coex `PioSpi`):
- `ws2812.rs`: `Peripheral`/`PeripheralRef`/`into_ref!` → `Peri<'d, T>`; PIO
  `Common`/`StateMachine` deltas; DMA `Channel::new(ch, Irqs)`.
- `main.rs`: `Pio::new`, DMA binding, `Flash::new_blocking` (new Flash API),
  `Output`, `bind_interrupts`.
- `panic.rs`: `Output` + `Peripherals::steal` — re-verify on the new rev.
- `status.rs`/`leda.rs`/`fs.rs`: HAL-light; `fs.rs` uses embassy-rp `Flash`
  (`embedded-storage`, stable). Re-confirm `blocking_read`/`blocking_write`/`blocking_erase`.
- **PIO/DMA allocation:** cyw43 `PioSpi` needs a PIO + 2 DMA (CH0+CH1); WS2812 needs
  a PIO SM + 1 DMA. Put **WS2812 on PIO1**, **cyw43 on PIO0**; give WS2812 its own
  DMA channel. (RP2040/RP2350 both have PIO0+PIO1.)
- Validate: flash once (button), the selected pattern still plays.

### Phase C — USB dev tooling (do it right, once) — ✅ DONE (HW-validated 2026-07-13)
**Full button-free cycle proven on the bench:** running firmware →
`picotool reboot -f -u` drops to BOOTSEL (no button) → `picotool load -x` reflashes
→ back to playing, serial re-enumerates as `/dev/cu.usbmodemLEDA_00012` in ~2 s. CDC
serial logger streams real telemetry (caught `alive — frame 120/180` heartbeat).
**The physical BOOTSEL button is retired** — all further dev iteration is CLI.
Details below.


Built [`src/usb.rs`](../src/usb.rs): one embassy-usb device with **(1)** a picotool
**reset interface** — vendor iface `0xFF`/`0x00`/`0x01`, a `Handler::control_out`
that on a Class-to-Interface request with `bRequest 0x01` calls
`embassy_rp::rom_data::reset_to_usb_boot(0, 0)` — and **(2)** a **CDC-ACM serial
logger** (`embassy-usb-logger` `with_class!`, attached to the same `Builder`).
Spawned from `main` (`USBCTRL_IRQ` bound); `log::info!` heartbeat every ~5 s + a
"playing: N leds…" line so serial is verifiable anytime. Builds clean, UF2 **87.5 KB**
(+30 KB for the USB stack). API note (this embassy rev): `#[task]` fns return
`Result<SpawnToken,_>` and `Spawner::spawn` returns `()`, so spawn as
`spawner.spawn(task(args).unwrap())`.
- **PENDING: one last BOOTSEL-button flash** of `led-animator-phaseC.uf2` (Phase B
  on the bench has no reset interface yet, so this first flash still needs the button).
- Validate after flashing: `picotool reboot -f -u` drops the running device to
  BOOTSEL (no button); `picotool load -x led-animator-phaseC.uf2` reflashes; serial
  log readable on `/dev/cu.usbmodem*` (e.g. `screen /dev/cu.usbmodem* 115200`).
  **Once `reboot -f -u` works: the physical BOOTSEL button is retired.**

### Phase D — CYW43 bring-up in the player — ✅ DONE (HW-validated 2026-07-13)
[`src/radio.rs`](../src/radio.rs): `cyw43::new_with_bluetooth` (fw + btfw + clm +
real `nvram_rp2040.bin`) on **PIO0 + DMA_CH0/CH1**, spawns the runner, `control.init`,
onboard LED on via `control.gpio_set(0, true)`. Wired as `BootStage::Radio` (dim
blue) — a **blocking** boot step: a dead chip hangs in init and LED 0 stays frozen
blue (the designed hang-on-stage behavior). Returns `Radio { control, net_device,
bt_device }` for Phases E/F.
- **Design split (parity reconciliation):** the CYW43 *chip* comes up at boot
  (blocking, fatal-on-hang — a dead radio = RMA); *joining a Wi-Fi AP* is a separate
  background, non-fatal step (Phase F), matching MicroPython's lazy join and the
  `Wifi=Warn` codes. So the pattern's start is delayed only by the ~sub-second chip
  init, not by network association.
- **Validated by control flow:** `radio::init()` is `await`ed *before* the play loop,
  so the steady serial heartbeats (`alive — frame N/M`) prove init returned — a
  non-responsive chip would hang with no heartbeats. Player + cyw43 runner coexist
  (steady frame progress). Onboard LED driven on = radio-alive (visual confirm bench).
- **First flash via the button-free workflow** (`picotool reboot -f -u` →
  `load -x`), no BOOTSEL button. UF2 grew to 648 KB (embeds the 231 KB Wi-Fi + 6 KB
  BT firmware blobs).
- Observability note: the one-shot boot logs are emitted before the host re-opens
  the CDC (~2 s post-reboot) so they're dropped; steady-state heartbeats are the
  reliable signal. A richer periodic status line lands with the networking phases
  (dynamic Wi-Fi/BLE state to report).

### Phase E — BLE control channel — 🔬 CODE DONE 2026-07-13 (live round-trip pending)
Built the shared control path: [`state.rs`](../src/state.rs) (mode/brightness/speed/
file/name behind an async Mutex), [`protocol.rs`](../src/protocol.rs) (transport-
agnostic `dispatch` — PING/INFO/VERSION/PLATFORM/BRIGHT/SPEED/SOLID/OFF/PLAY/
NAME-query/BOOTSEL), and [`ble.rs`](../src/ble.rs) (trouble-host **NUS** service on
the LED Animator service UUID; RX write → `dispatch` → TX notify). Advertises the
service UUID (verified LE byte order = `u128::to_le_bytes`) with the device name in
the scan response.
- **Validated:** compiles clean; on the bench it advertises (`BLE: advertising as
  "LED Animator"`) while the player keeps running — and the underlying trouble-host
  transport (advertise + connect + GATT + notify) was already bench-proven by the
  coex spike.
- **Pending (needs a BLE central):** the live command round-trip. Blocked here
  because the Pi bench's BT adapter is held by a running `leader_headless.py` sync
  leader (raw HCI, so BlueZ/bleak can't use it) and this Mac's CLI Bluetooth is TCC-
  blocked. **To validate:** run [`tools/ble_test.py`](../tools/ble_test.py) from any
  machine with a free BLE central, or use nRF Connect (write a command to the RX
  char `6E40…0002`, read the reply on the TX char `6E40…0003`). The app will also
  exercise it. Watch the strip: `SOLID 0 255 0` → green, `BRIGHT 25` → dim, `OFF` →
  blank, `PLAY` → resume.
- **Still TODO on BLE control:** filesystem-backed verbs (LIST/SELECT/DELETE/FREE/
  MOREINFO/NAME-set + persistence), auth (LOGIN/SETPASS/CLEARPASS + locking),
  manufacturer-data device id in the advert, unsolicited INFO broadcast on change.

### Phase F — Wi-Fi — 🔬 CODE DONE 2026-07-13 (live join pending credentials)
[`src/wifi.rs`](../src/wifi.rs): if `networks.txt` has credentials (line 1 SSID, line
2 password), bring up embassy-net over the CYW43 net driver, join (retry loop;
non-fatal), and serve the shared `protocol::dispatch` over **TCP :4550** (line in →
reply out — same commands as BLE). Gated on `networks.txt`; a device with none skips
cleanly. **Bench-checked: no regression** (no `networks.txt` → logs "skipping", BLE +
player run normally). Live join + TCP validate with real credentials.
- **TODO on Wi-Fi:** the `WIFI*` provisioning commands (WIFISCAN/WIFISSID/WIFIPASS/
  WIFICONNECT/WIFISTATUS/WIFIFORGET — WIFICONNECT writes `networks.txt` + triggers a
  join, needs shared-fs dispatch + a join trigger), the **UDP `LEDADISCOVER`**
  responder (`LEDA <hostname> <name>`), and reporting Wi-Fi state in `INFO`/`MOREINFO`.

### Done this session (2026-07-13): status recap
✅ Phase D radio · ✅ recovery ritual · ✅ state-driven player · ✅ command dispatch core
· ✅ **BOOTSEL protocol command** (in `protocol.rs`) · 🔬 BLE control (advertises) · 🔬
Wi-Fi auto-join + TCP. Everything committed to `main` (not pushed).

### Validation plan for the next bench/app session
1. **BLE control round-trip** — run [`tools/ble_test.py`](../tools/ble_test.py) from a
   BLE-capable machine, or nRF Connect / the app. Expect PING→OK, INFO→state line,
   SOLID/BRIGHT/OFF/PLAY visibly change the strip. (Blocked tonight: no free BLE central.)
2. **Wi-Fi** — put a `networks.txt` on the device (SSID\npassword) — or build+use
   WIFICONNECT — then `nc <device-ip> 4550` and send commands. Watch for `wifi: IP …`
   in the serial log.
3. Once the BLE/Wi-Fi *foundation* is confirmed, build the rest **on proven ground**:
   fs-backed verbs, auth, Wi-Fi provisioning, sync, power.

### Phase E+ / G+ — the remaining parity work
The numbered contract below, still to port: **fs-backed control verbs** (LIST/SELECT/
DELETE/FREE/MOREINFO/NAME-set + `bright.txt`/`state.txt`/`selected.txt` persistence —
needs a shared-fs refactor: `FlashStorage`+`Allocation` via `StaticCell`, fs behind a
`Mutex`, passed to dispatch), **auth PIN** (`sha2` challenge-response + per-connection
lock, gating all but PING/INFO/LOGIN), **BLE sync** (connectionless beacon advertise/
scan + follower PLL — `sync-beacon.md`), **Wi-Fi provisioning + UDP discover**, and
**power sensing** (⚠️ on Pico W, VSYS/GPIO29 is shared with the CYW43 SPI clock this
firmware uses — needs ADC/radio coordination, not a plain `ADC(29)` read).

## Remaining work — the plan

The order mirrors the Python's own build order. Each piece has a settled contract
in the repo docs. (Item 1 — config + littlefs — is **DONE**; see the status table.)

1. **Config + littlefs on flash.** The Python reads `datapin.txt`, `bright.txt`,
   `selected.txt`, `state.txt`, `syncflags.txt`, `auth.txt`, `bootcount.txt`,
   `standalone.txt`, `networks.txt`, and the `*.leda` patterns from a littlefs FS
   in flash. Plan: the [`littlefs2`] crate over an `embedded-storage` flash region
   (embassy-rp `Flash`), reusing the **same layout** the web UF2 builds
   (`fsBase 0x1012c000`, 212×4096) so existing bundles Just Work. This unblocks
   playing real patterns + all persisted settings.
2. **Power-cycle recovery ritual.** ✅ **CODE DONE 2026-07-13** ([`src/recovery.rs`](../src/recovery.rs)).
   `bump_and_act` bumps `bootcount.txt` right after mount (before radio, so it climbs
   even if a dead radio hangs boot); `commit` removes it at the top of the run loop
   (COMMIT_MS = 0). 5th short boot → remove `auth.txt` (cyan whole-strip flash); 10th
   → also remove `networks.txt` + write `standalone.txt` (magenta). Counts 2–4/6–9
   light N dim-white pixels; 1 is silent. **No regression** (boots + plays normally,
   so bump/commit work on the live path) and built on the already-HW-validated
   littlefs write/remove. **Physical 5×/10× ritual pending bench validation** — CLI
   reboots can't reliably interrupt within the boot window and the early boot logs
   drop before the host re-enumerates the CDC, so the strip-watching validation
   (like the MicroPython one) is a bench task. Note: de-group via `standalone.txt` is
   written now; it takes effect once sync/role lands (Phase 5).
3. **CYW43 bring-up.** `cyw43` + `cyw43-pio` (the SPI-over-PIO the Pico W uses),
   embedding the firmware + CLM blobs. Gateway to both Wi-Fi and BLE. Finicky;
   do it in isolation first (join a network, blink the on-chip LED).
4. **Wi-Fi control.** `embassy-net` (smoltcp) for the TCP server on **:4550** and
   the UDP `LEDADISCOVER` responder; port the line protocol
   ([`protocol.md`](../../docs/protocol.md)) — the command dispatch is a big but
   mechanical `match`.
5. **BLE control + sync.** The hard one. `trouble-host` (Rust BLE host) over the
   CYW43 HCI for: the Nordic-UART control service, the connectionless **sync
   beacon** advertise (leader) + scan (follower), and the follower **PLL**
   ([`sync-beacon.md`](../../docs/sync-beacon.md), `multi-device-sync.md`).
   Concurrent advertise+scan+GATT+Wi-Fi on the CYW43 is the thing to validate — it
   works in MicroPython; confirm the Rust stack manages it. Expect this to be the
   bulk of the remaining effort.
6. **Auth PIN.** Challenge-response (`sha256(pin+nonce)` — a `sha2`/`hmac` crate),
   per-connection state; port [`config-and-auth-plan.md`](../../docs/config-and-auth-plan.md) §2.
7. **Power sensing.** VSYS ADC on GPIO29 + USB-present on the CYW43 — small.

## Gotchas hit (so the next session doesn't re-hit them)

- **Toolchain:** Homebrew `cargo`/`rustc` are first in PATH but lack the cross-std;
  prepend the rustup toolchain bin (above) or builds fail with "can't find crate
  for `core`".
- **`portable-atomic` `critical-section` feature** is required — Cortex-M0+ has no
  native atomic CAS, so `static_cell`/embassy won't compile without it.
- **littlefs2 drags in `delog`, which needs atomic CAS.** thumbv6m lacks it, so
  delog fails to compile until you add a direct `delog = { features =
  ["portable-atomic"] }` dep — that routes delog to `portable-atomic` (whose
  `critical-section` feature supplies the CAS). Also use `littlefs2 = {
  default-features = false }`. With that, littlefs2-sys's **C cross-compiles fine
  for thumbv6m** via the Homebrew `arm-none-eabi-gcc` + the `cc` crate.
- **littlefs2 pins on-disk version 2.0; our images are 2.1 → `-22` (INVAL) on
  mount.** The crate hardcodes `DISK_VERSION = Version(0x0002_0000)` (2.0, via the
  multiversion feature), but the web app's littlefs (wokwi `littlefs` npm 0.1.0)
  and MicroPython write **disk version 2.1**, and littlefs refuses to mount a fs
  newer than the configured disk version. Fix: a one-line **fork of littlefs2**
  (`../../littlefs2`, commit `b008a1e`, `DISK_VERSION → 2.1`) wired via
  `[patch.crates-io]`. The wokwi lib can't emit 2.0 (no multiversion), and existing
  devices are all 2.1, so 2.1 is the standard. Root-caused/validated on host with
  the real flash dump + littlefs-python (which mounts 2.1 since it uses latest).
- **littlefs path ops need libc string fns.** `lfs_dir_find` (any open-by-name)
  calls `strspn`/`strcspn`/`strchr`, absent in no_std — link fails with undefined
  symbols the moment you open a file (bare `mount` links fine). Fix: enable
  `littlefs2-sys`'s **`tinyrlibc`** feature (a no_std C-string impl). Its `c-stubs`
  feature only covers `strcpy`/`strlen`, so it's not enough on its own.
- **`memory.x` needs a `BOOT2` region** (0x100 @ 0x10000000); embassy-rp's
  `link-rp.x` fills it with a default boot2 + CRC.
- **cyw43 + trouble-host version skew is the real wall, not capability.** The
  crates.io release matrix is internally inconsistent: cyw43 0.7.0 pins bt-hci
  0.8, trouble-host 0.7.0 pins bt-hci 0.9, and trouble-host 0.6 drags in an
  incompatible embassy-sync. The fix (what trouble's own `examples/rp-pico-w`
  does): take **trouble-host from git** and `[patch.crates-io]` **cyw43 + every
  embassy crate to one embassy git rev** (spike-coex uses `1d3c3de`) where cyw43
  has already moved to bt-hci 0.9 to match trouble main. One rev ⇒ one bt-hci,
  one embassy-sync. Bump the rev only in lockstep with trouble-host. **Caveat:**
  that git rev's `embassy-usb` doesn't build cleanly (an `embedded-io` skew) and
  its USB `Driver` trait won't match a crates.io `embassy-usb`, so **no USB-CDC
  logger on this graph** — spike-coex proves coexistence with physical telemetry
  (on-chip LED = Wi-Fi liveness, phone BLE scanner = BT liveness) instead.
  Also note the git embassy-rp `PioSpi::new` takes **two** DMA channels
  (CH0+CH1) vs crates.io 0.10's one, and the cyw43 runner type gained a third
  generic `Cyw43439`.
- **CYW43 needs the real `nvram_rp2040.bin`** as the 6th arg to
  `new_with_bluetooth` (and to `new`). Passing empty `Aligned([0u8; 0])` — which
  is only valid with the `skip-cyw43-firmware` feature — makes the chip come up
  unconfigured: init **hangs before returning**, the on-chip LED stays dark, and
  (fatally for debugging) it hangs *before* the USB logger can flush, so the
  serial console is silent too. Cost us a whole diagnostic cycle. Grab the blob
  from `embassy/cyw43-firmware/nvram_rp2040.bin` and load it with
  `cyw43::aligned_bytes!`. Confirmed on the bench 2026-07-12: with real NVRAM,
  `new_with_bluetooth` → `control.init(clm)` → `control.gpio_set` all succeed and
  the on-chip LED blinks.
- **No debug probe → USB CDC logger is the only observability**, and it only
  flushes when the executor keeps running. A hang/panic *before* the first yield
  after a log call = silence, indistinguishable from "logger broken." When bring-up
  is suspect, drive the **external WS2812 strip (GP0, independent of the CYW43)** as
  a hardware stage-indicator too — it can't lie about how far boot got.
- **No way back to BOOTSEL in software yet.** Re-flashing needs the physical
  BOOTSEL button. Two fixes, both worth doing:
  - **Now (for CLI dev iteration):** a tiny `embassy-usb` device exposing the
    **picotool reset interface** (+ a CDC serial for `defmt`/logging — the
    observability this firmware totally lacks), so `picotool reboot -f -u` works.
  - **At parity:** a **`BOOTSEL` control command** (reboot into the RP2040 USB
    bootloader via the bootrom `reset_to_usb_boot`) matching the one the
    MicroPython firmware already has (see [`protocol.md`](../../docs/protocol.md)
    → Maintenance) — so the app/CLI can drop the device into the `RPI-RP2` drive
    over BLE/Wi‑Fi and a new `.uf2` is dragged on. The old firmware installs the
    new one, no button.

## Bench state (2026-07-13)

The bench Pico W runs the **Phase-C Rust firmware** (`firmware-rust/led-animator-phaseC.uf2`):
plays the selected `.leda` from the real littlefs on **GP0 via PIO1 + DMA_CH2**, and
exposes the **USB dev tooling** — reflash with **no button** via
`picotool reboot -f -u` then `picotool load -x <uf2>`; serial log on
`/dev/cu.usbmodemLEDA_00012` (e.g. `screen /dev/cu.usbmodemLEDA_00012 115200`).
Build+flash from scratch:
```bash
cd firmware-rust && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo build --release
~/.cargo/bin/elf2uf2-rs target/thumbv6m-none-eabi/release/led-animator-fw led-animator.uf2
picotool reboot -f -u   # drop the running device to BOOTSEL (no button)
picotool load -x led-animator.uf2
```
Original MicroPython + littlefs backed up at
**`~/pico-bench-micropython-backup-2026-07-09.bin`** (full 2 MB). Restore Python:
BOOTSEL, `picotool load ~/pico-bench-micropython-backup-2026-07-09.bin` (littlefs
survives a small-firmware flash).

[`littlefs2`]: https://crates.io/crates/littlefs2
