# Phase-A graph spike — where we are

**Goal:** prove ONE dep graph resolves + compiles + links for thumbv6m with
networking (cyw43 + trouble) **and** embassy-usb + embassy-usb-logger + embassy-net
+ littlefs(fork) all present. This is the migration GATE (PORT.md → Phase A).

## The decision this spike is testing
- crates.io skew is still real: **cyw43 0.7.0 → bt-hci ^0.8**, **trouble-host 0.7.0 → bt-hci ^0.9** (no overlap).
- BUT embassy **git main** cyw43 already moved to **bt-hci 0.9.0**, and embassy-usb
  main is on **embedded-io-async 0.7.0** (matching everything) — so the embedded-io
  skew that broke USB on the old coex rev `1d3c3de` should be GONE on main.
- Approach: pin **all embassy + cyw43 + cyw43-pio to embassy main rev
  `9ae6c574e20d6e21ab19f31575adbc4559f3d082`** (2026-07-12); trouble-host 0.7.0 +
  bt-hci 0.9.0 from crates.io; littlefs2 = ke4ukz fork `b008a1e`.

## Status: ✅ PASSED (2026-07-12) — compiles + links, 0 warnings, 371 KB ELF
Build cmd (needs rustup toolchain on PATH for the cross-std):
```
cd firmware-rust/spike-graph
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo build --release   # -> target/thumbv6m-none-eabi/release/graph-spike
```

Everything that was ever a risk built together:
- **embassy-usb 0.6.0 + embassy-usb-logger 0.6.0** (git main) — the crates broken
  on the old coex rev `1d3c3de` — compile & link. The embedded-io skew is gone:
  embassy-usb, bt-hci, cyw43 all use embedded-io-async **0.7.0**.
- **cyw43 0.7.0 (git main) + trouble-host 0.7.0 (crates.io) + bt-hci 0.9.0** agree;
  `ExternalController::new(bt_device)` type-checks (HCI Transport seam matches).
- **embassy-net 0.9.1** over the cyw43 net driver.
- **littlefs2 (fork b008a1e) + littlefs2-sys + tinyrlibc + delog** coexist w/ new embassy.

### The exact working graph (from Cargo.lock)
| crate | version | source |
|---|---|---|
| embassy-executor/rp/time/sync/futures/net/usb/usb-logger | (0.10/0.10/0.5.1/0.8/0.1/0.9.1/0.6/0.6) | **embassy git rev `9ae6c574e20d6e21ab19f31575adbc4559f3d082`** (main, 2026-07-12) |
| cyw43 0.7.0, cyw43-pio 0.10.0 | | same embassy git rev |
| trouble-host | 0.7.0 | crates.io |
| bt-hci | 0.9.0 | crates.io |
| littlefs2 | 0.8.0 | ke4ukz fork rev `b008a1e` |
| littlefs2-sys 0.4.0 (tinyrlibc), delog 0.1.8, tinyrlibc 0.5.1 | | crates.io |

Notes for Phase B: this is the **git-embassy API**, so the player must move to it:
`embassy-executor` feature is **`platform-cortex-m`** (not `arch-cortex-m`);
`PioSpi::new` takes **two** DMA channels + `dma::Channel::new(ch, Irqs)`; the cyw43
`Runner`/`SpiBus` gained the **`Cyw43439`** generic; DMA irqs bind via
`dma::InterruptHandler`. See src/main.rs for the exact call shapes.

## Hardware note
Pico is in BOOTSEL (harmless). No flash needed for Phase A — it's compile-only.
Clean `led-animator.uf2` sits in firmware-rust/ to restore anytime.
