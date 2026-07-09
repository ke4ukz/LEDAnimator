#![no_std]
#![no_main]

mod leda;
mod status;
mod ws2812;

use embassy_executor::Spawner;
use embassy_rp::bind_interrupts;
use embassy_rp::peripherals::PIO0;
use embassy_rp::pio::{InterruptHandler, Pio};
use embassy_time::{Duration, Ticker};
use panic_halt as _;
use static_cell::StaticCell;
use ws2812::Ws2812;

bind_interrupts!(struct Irqs {
    PIO0_IRQ_0 => InterruptHandler<PIO0>;
});

// 1000 = the MicroPython STATUS_BLANK_LEDS ceiling (boot-clear / status writes).
const MAX_LEDS: usize = 1000;
// Kept off the task future (would blow the executor arena); lives in .bss.
static FRAME_BUF: StaticCell<[u32; MAX_LEDS]> = StaticCell::new();

// Embedded test pattern until flash/littlefs reading lands (see docs/PORT.md).
static TEST_PATTERN: &[u8] = include_bytes!("../test-pattern.leda");

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    let p = embassy_rp::init(Default::default());
    let Pio { mut common, sm0, .. } = Pio::new(p.PIO0, Irqs);
    // Data pin GP0 = the MicroPython default (datapin.txt override comes later).
    let mut ws: Ws2812<PIO0, 0> = Ws2812::new(&mut common, sm0, p.DMA_CH0, p.PIN_0);
    let buf = FRAME_BUF.init([0u32; MAX_LEDS]);

    // Boot-clear the strip (any length), like the Python `_show_solid black`.
    ws.show(&buf[..]).await;

    let bright: u8 = 255;
    match leda::Pattern::parse(TEST_PATTERN) {
        Some(pat) if pat.header.num_frames > 0 && pat.header.num_leds > 0 => {
            let n = (pat.header.num_leds as usize).min(MAX_LEDS);
            let fps = pat.header.fps.max(1) as u64;
            let mut ticker = Ticker::every(Duration::from_micros(1_000_000 / fps));
            let mut frame = 0u32;
            loop {
                if let Some(rgb) = pat.frame(frame) {
                    leda::fill_grb(rgb, &mut buf[..n], bright);
                    ws.show(&buf[..n]).await;
                }
                frame += 1;
                if frame >= pat.header.num_frames {
                    frame = 0;
                }
                ticker.next().await;
            }
        }
        // No valid/playable pattern: LED0 red "nofile" pulse, strip dark.
        _ => {
            let mut ticker = Ticker::every(Duration::from_millis(33));
            loop {
                for w in buf.iter_mut() {
                    *w = 0;
                }
                buf[0] = status::led0_word(status::Status::Nofile);
                ws.show(&buf[..]).await;
                ticker.next().await;
            }
        }
    }
}
