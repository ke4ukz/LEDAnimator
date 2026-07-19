//! Raspberry Pi Pico 2 W — RP2350 (Cortex-M33). Memory layout is `memory-rp2350.x`
//! (IMAGE_DEF boot block + 2 MB flash window + 512 KB RAM); the target triple is
//! selected in `.cargo/config.toml` / `build.rs`.

use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::peripherals::FLASH;

/// Human-readable platform, reported over the wire (`PLATFORM` command).
pub const PLATFORM: &str = "Raspberry Pi Pico 2 W with RP2350";

/// Per-board unique id — the RP2350's random chip id from OTP (the flash unique-id
/// helper is RP2040-only). `flash` is unused here, kept for a uniform signature.
pub fn unique_id<const N: usize>(_flash: &mut Flash<'_, FLASH, Blocking, N>) -> u64 {
    embassy_rp::otp::get_chipid().unwrap_or(0)
}

/// CYW43 PIO-SPI clock divider for this board's system clock (150 MHz). The RP2350
/// runs the PIO faster than the RP2040, so the Pico 2 W needs the RM2 divider, not
/// the RP2040 default.
#[cfg(any(feature = "wifi", feature = "bt"))]
pub use cyw43_pio::RM2_CLOCK_DIVIDER as CYW43_CLOCK_DIVIDER;
