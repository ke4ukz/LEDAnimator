//! Panic handler — a rapid red flutter on LED 0 (see docs/led0-status.md → Panic).
//!
//! A crash must not just freeze silently. We can't use the async WS2812 driver
//! from a panic (its PIO/DMA state is mid-flight and the executor is dead), so we
//! bit-bang the single first pixel directly on the data pin with cycle-timed
//! delays, after disabling interrupts. Driving it through embassy's `Output`
//! cleanly reclaims the pin from the PIO (funcsel → SIO) without register-bashing.
//!
//! Timing is calibrated for the 125 MHz default sysclk and **HW-validated on the
//! bench 2026-07-12** (clean red ~4 Hz flutter). Data pin is GP0 (the player
//! default); when the pin becomes configurable this must select it dynamically.

use crate::ws2812::grb_word;
use core::panic::PanicInfo;
use embassy_rp::gpio::{Level, Output};

// Empirically, `cortex_m::asm::delay(n)` here is ~1.8 sysclk cycles per unit
// (the WS2812 0/1 high-time threshold, ~0.5 µs ≈ 62 cy, landed between 33 and 38
// units in bench tests). So these units are ≈ 1.8 cy ≈ 14 ns each @125 MHz. The
// bit VALUE is the high time — kept far apart (0 ≈ 0.29 µs, 1 ≈ 0.83 µs) with
// margin on both sides of the threshold. The LOW times are generous (~0.8 µs) so
// every falling edge registers — too-short lows after a full byte of 1s make the
// following 0-bits mis-sample as 1s (red→magenta, off→blue).
const T0H: u32 = 20; // 0-bit high  ~0.29 µs (clearly a 0)
const T0L: u32 = 55; // 0-bit low   ~0.79 µs
const T1H: u32 = 58; // 1-bit high  ~0.83 µs (clearly a 1)
const T1L: u32 = 55; // 1-bit low   ~0.79 µs

#[inline(always)]
fn ws_bit(out: &mut Output<'_>, one: bool) {
    out.set_high();
    cortex_m::asm::delay(if one { T1H } else { T0H });
    out.set_low();
    cortex_m::asm::delay(if one { T1L } else { T0L });
}

/// Shift one GRB<<8 word (bits 31..8, MSB first) to the first pixel, then hold the
/// reset latch.
fn ws_word(out: &mut Output<'_>, grb: u32) {
    for i in 0..24 {
        ws_bit(out, (grb >> (31 - i)) & 1 != 0);
    }
    out.set_low();
    cortex_m::asm::delay(8_000); // >50 µs reset latch
}

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    cortex_m::interrupt::disable();
    // We're crashing — steal the peripherals to reclaim the data pin (GP0).
    let p = unsafe { embassy_rp::Peripherals::steal() };
    let mut out = Output::new(p.PIN_0, Level::Low);
    let red = grb_word(255, 0, 0);
    loop {
        // ~4 Hz flutter: red pixel, then dark — fast enough to read as "not a
        // status," slow enough not to strobe. (~5M units × 3 cy ≈ 120 ms/phase.)
        ws_word(&mut out, red);
        cortex_m::asm::delay(8_000_000); // ~115 ms @ ~1.8 cy/unit → ~4 Hz
        ws_word(&mut out, 0);
        cortex_m::asm::delay(8_000_000);
    }
}
