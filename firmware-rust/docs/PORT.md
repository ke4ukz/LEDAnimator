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
| Master brightness scaling | ✅ (in `fill_grb`) | `leda.rs` |
| Config files / littlefs on flash | ⏳ not started | — |
| BLE control (advertise + GATT + dispatch) | 📋 planned | — |
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

## Remaining work — the plan

The order mirrors the Python's own build order. Each piece has a settled contract
in the repo docs.

1. **Config + littlefs on flash.** The Python reads `datapin.txt`, `bright.txt`,
   `selected.txt`, `state.txt`, `syncflags.txt`, `auth.txt`, `bootcount.txt`,
   `standalone.txt`, `networks.txt`, and the `*.leda` patterns from a littlefs FS
   in flash. Plan: the [`littlefs2`] crate over an `embedded-storage` flash region
   (embassy-rp `Flash`), reusing the **same layout** the web UF2 builds
   (`fsBase 0x1012c000`, 212×4096) so existing bundles Just Work. This unblocks
   playing real patterns + all persisted settings.
2. **Power-cycle recovery ritual.** Pure logic (`bootcount.txt`, 5×/10× thresholds,
   commit-on-boot-completion). Trivial once (1) exists — port
   [`config-and-auth-plan.md`](../../docs/config-and-auth-plan.md) §3 directly.
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
- **`memory.x` needs a `BOOT2` region** (0x100 @ 0x10000000); embassy-rp's
  `link-rp.x` fills it with a default boot2 + CRC.
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

## Bench state (2026-07-09)

The bench Pico W (GP0 strip, 8 LEDs — read from its `datapin.txt`) was **flashed
with this Rust firmware** and is running the embedded moving-rainbow test pattern.
Its original MicroPython + littlefs (patterns, config, `networks.txt`) is backed
up at **`~/pico-bench-micropython-backup-2026-07-09.bin`** (full 2 MB). To restore
Python: BOOTSEL, then `picotool load ~/pico-bench-micropython-backup-2026-07-09.bin`
(or flash a fresh MicroPython UF2 — the littlefs survives a small-firmware flash).

[`littlefs2`]: https://crates.io/crates/littlefs2
