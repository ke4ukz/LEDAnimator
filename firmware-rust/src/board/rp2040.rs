//! Raspberry Pi Pico W — RP2040 (Cortex-M0+). Memory layout is `memory-rp2040.x`
//! (boot2 + 2 MB flash + 264 KB RAM); the target triple + boot2 link script are
//! selected in `.cargo/config.toml` / `build.rs`.

use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::peripherals::FLASH;

/// Human-readable platform, reported over the wire (`PLATFORM` command).
pub const PLATFORM: &str = "Raspberry Pi Pico W with RP2040";

/// Per-board unique id — the SPI flash unique id (RP2040 exposes it on `Flash`;
/// the RP2350 OTP path lives in that board's file). Generic over flash size so it
/// takes whatever `Flash` main already holds.
pub fn unique_id<const N: usize>(flash: &mut Flash<'_, FLASH, Blocking, N>) -> u64 {
    let mut b = [0u8; 8];
    let _ = flash.blocking_unique_id(&mut b);
    u64::from_le_bytes(b)
}

/// CYW43 PIO-SPI clock divider for this board's system clock (125 MHz).
#[cfg(any(feature = "wifi", feature = "bt"))]
pub use cyw43_pio::DEFAULT_CLOCK_DIVIDER as CYW43_CLOCK_DIVIDER;
