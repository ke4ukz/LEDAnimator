//! Raspberry Pi Pico W — RP2040 (Cortex-M0+). Memory layout is `memory-rp2040.x`
//! (boot2 + 2 MB flash + 264 KB RAM); the target triple + boot2 link script are
//! selected in `.cargo/config.toml` / `build.rs`.

/// Human-readable platform, reported over the wire (`PLATFORM` command).
pub const PLATFORM: &str = "Raspberry Pi Pico W with RP2040";

/// CYW43 PIO-SPI clock divider for this board's system clock (125 MHz).
#[cfg(any(feature = "wifi", feature = "bt"))]
pub use cyw43_pio::DEFAULT_CLOCK_DIVIDER as CYW43_CLOCK_DIVIDER;
