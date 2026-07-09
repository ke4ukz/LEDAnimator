//! WS2812 output via PIO + DMA — the Rust port of the MicroPython `_show_grb`
//! path (see `web/src/export/rp2040.ts`).
//!
//! Each LED is a **32-bit GRB<<8 word**: `(g<<24) | (r<<16) | (b<<8)` — identical
//! to the Python `_fill_grb`. A frame is a `&[u32]` slice DMA-pushed to a PIO
//! state machine that clocks it out at 800 kHz. The clock divider is derived from
//! the *actual* system clock, so the same code holds timing on RP2040 (125 MHz)
//! and RP2350 (150 MHz) — the same portability the Python relied on.
//!
//! Unlike embassy's built-in `PioWs2812<N>` (fixed LED count, `[RGB8; N]`), this
//! takes a **variable-length** word slice, because the strip length is only known
//! at runtime from the pattern header. The DMA is awaited, so the executor runs
//! other tasks (housekeeping, later networking) during the ~30 µs/LED shift-out —
//! the async equivalent of the Python's "kick DMA, do work, then sleep" loop.

use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::dma::{AnyChannel, Channel};
use embassy_rp::pio::program as piolib; // the `pio` crate, re-exported by embassy-rp
use embassy_rp::pio::{Common, Config, FifoJoin, Instance, PioPin, ShiftConfig, ShiftDirection, StateMachine};
use embassy_rp::{into_ref, Peripheral, PeripheralRef};
use embassy_time::Timer;
use fixed::types::U24F8;

// WS2812 bit timing in PIO cycles (T1 start / T2 data / T3 stop) — 10 cycles/bit.
const T1: u8 = 2;
const T2: u8 = 5;
const T3: u8 = 3;
const CYCLES_PER_BIT: u32 = (T1 + T2 + T3) as u32;

/// Pack an (r,g,b) triple into the GRB<<8 word the PIO shifts out (matches the
/// MicroPython `_fill_grb`).
#[inline(always)]
pub fn grb_word(r: u8, g: u8, b: u8) -> u32 {
    ((g as u32) << 24) | ((r as u32) << 16) | ((b as u32) << 8)
}

pub struct Ws2812<'d, P: Instance, const S: usize> {
    dma: PeripheralRef<'d, AnyChannel>,
    sm: StateMachine<'d, P, S>,
}

impl<'d, P: Instance, const S: usize> Ws2812<'d, P, S> {
    pub fn new(
        common: &mut Common<'d, P>,
        mut sm: StateMachine<'d, P, S>,
        dma: impl Peripheral<P = impl Channel> + 'd,
        pin: impl PioPin,
    ) -> Self {
        into_ref!(dma);

        // Assemble the WS2812 program (side-set drives the data line; the T1/T2/T3
        // delays shape the 1-vs-0 pulse widths). Copied from embassy's ws2812.
        let side_set = piolib::SideSet::new(false, 1, false);
        let mut a: piolib::Assembler<32> = piolib::Assembler::new_with_side_set(side_set);
        let mut wrap_target = a.label();
        let mut wrap_source = a.label();
        let mut do_zero = a.label();
        a.set_with_side_set(piolib::SetDestination::PINDIRS, 1, 0);
        a.bind(&mut wrap_target);
        a.out_with_delay_and_side_set(piolib::OutDestination::X, 1, T3 - 1, 0); // stop bit
        a.jmp_with_delay_and_side_set(piolib::JmpCondition::XIsZero, &mut do_zero, T1 - 1, 1); // start bit
        a.jmp_with_delay_and_side_set(piolib::JmpCondition::Always, &mut wrap_target, T2 - 1, 1); // data 1
        a.bind(&mut do_zero);
        a.nop_with_delay_and_side_set(T2 - 1, 0); // data 0
        a.bind(&mut wrap_source);
        let prg = a.assemble_with_wrap(wrap_source, wrap_target);
        let loaded = common.load_program(&prg);

        let mut cfg = Config::default();
        let out_pin = common.make_pio_pin(pin);
        cfg.set_out_pins(&[&out_pin]);
        cfg.set_set_pins(&[&out_pin]);
        cfg.use_program(&loaded, &[&out_pin]);

        // Clock so one bit = 1.25 µs (800 kHz × 10 cycles), from the real sysclk.
        let clock_freq = U24F8::from_num(clk_sys_freq() / 1000);
        let ws2812_freq = U24F8::from_num(800);
        cfg.clock_divider = clock_freq / (ws2812_freq * CYCLES_PER_BIT);

        cfg.fifo_join = FifoJoin::TxOnly;
        cfg.shift_out = ShiftConfig {
            auto_fill: true,
            threshold: 24,
            direction: ShiftDirection::Left,
        };
        sm.set_config(&cfg);
        sm.set_enable(true);

        Self { dma: dma.map_into(), sm }
    }

    /// Shift out one frame of GRB<<8 words (one per LED). Awaits the DMA, then
    /// holds the >50 µs reset latch before returning.
    pub async fn show(&mut self, words: &[u32]) {
        self.sm.tx().dma_push(self.dma.reborrow(), words, false).await;
        Timer::after_micros(60).await;
    }
}
