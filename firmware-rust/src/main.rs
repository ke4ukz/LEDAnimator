#![no_std]
#![no_main]

mod fs;
mod leda;
mod panic; // registers the #[panic_handler] (LED-0 red flutter)
mod radio; // CYW43 Wi-Fi + BT bring-up
mod status;
mod usb; // picotool reset interface + CDC serial logger
mod ws2812;

use core::ptr::{addr_of, addr_of_mut};
use embassy_executor::Spawner;
use embassy_rp::peripherals::{DMA_CH0, DMA_CH1, DMA_CH2, PIO0, PIO1, USB};
use embassy_rp::pio::{InterruptHandler, Pio};
use embassy_rp::usb::{Driver as UsbDriver, InterruptHandler as UsbInterruptHandler};
use embassy_rp::{bind_interrupts, dma};
use embassy_time::{Duration, Ticker, Timer};
use littlefs2::fs::Filesystem;
use littlefs2::path::Path;
use static_cell::StaticCell;
use ws2812::Ws2812;

// WS2812 lives on PIO1 + DMA_CH2; the CYW43 PioSpi lives on PIO0 + DMA_CH0/CH1
// (Phase D). Both PIOs are identical, so GP0 output is unaffected. USBCTRL_IRQ
// drives the dev-tooling USB device (reset interface + serial log — Phase C).
bind_interrupts!(struct Irqs {
    PIO0_IRQ_0 => InterruptHandler<PIO0>;
    PIO1_IRQ_0 => InterruptHandler<PIO1>;
    DMA_IRQ_0 => dma::InterruptHandler<DMA_CH0>, dma::InterruptHandler<DMA_CH1>, dma::InterruptHandler<DMA_CH2>;
    USBCTRL_IRQ => UsbInterruptHandler<USB>;
});

// 1000 = the MicroPython STATUS_BLANK_LEDS ceiling (boot-clear / status writes).
const MAX_LEDS: usize = 1000;
// Kept off the task future (would blow the executor arena); lives in .bss.
static FRAME_BUF: StaticCell<[u32; MAX_LEDS]> = StaticCell::new();

// RAM buffer holding the selected `.leda`, loaded whole. Per-device sync slices
// stay well under this; streaming frames on demand is a future option for larger
// patterns. In .bss (a 128 KB stack temporary would overflow).
const PATTERN_MAX: usize = 128 * 1024;
static mut PATTERN_BUF: [u8; PATTERN_MAX] = [0; PATTERN_MAX];

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    // USB dev tooling first (Phase C): picotool reset interface + serial logger.
    // Reflash is now `picotool reboot -f -u` — no physical BOOTSEL button.
    let usb_driver = UsbDriver::new(p.USB, Irqs);
    spawner.spawn(usb::usb_task(usb_driver).unwrap());
    log::info!("LED Animator (Rust) booting");

    let Pio { mut common, sm0, .. } = Pio::new(p.PIO1, Irqs);
    // Data pin GP0 (fixed — no `datapin.txt`; see docs/led0-status.md rationale).
    let mut ws: Ws2812<PIO1, 0> = Ws2812::new(&mut common, sm0, p.DMA_CH2, Irqs, p.PIN_0);
    let buf = FRAME_BUF.init([0u32; MAX_LEDS]);

    // Boot-clear the strip (any length), like the Python `_show_solid black`.
    ws.show(&buf[..]).await;

    // --- Storage bring-up (boot-stage: dim magenta while mounting the flash fs) ---
    buf[0] = status::BootStage::Storage.led0_word();
    ws.show(&buf[..]).await;
    let flash = embassy_rp::flash::Flash::new_blocking(p.FLASH);
    let mut storage = fs::FlashStorage::new(flash);
    let mut alloc = Filesystem::allocate();
    let fs = match Filesystem::mount(&mut alloc, &mut storage) {
        Ok(fs) => fs,
        // Fatal: no readable storage — show the RMA code on LED 0, forever.
        Err(_) => halt_error(&mut ws, buf, status::errors::FS_MOUNT_FAILED).await,
    };

    // --- Config: master brightness + the selected pattern (loaded into PATTERN_BUF) ---
    let bright = read_bright(&fs);
    let pat_len = {
        let pbuf = unsafe { &mut *addr_of_mut!(PATTERN_BUF) };
        load_selected(&fs, pbuf)
    };

    // --- Radio bring-up (BootStage::Radio, dim blue). Blocking chip init; a dead
    // chip hangs here and LED 0 stays blue. Wi-Fi join + BLE start later as tasks. ---
    buf[0] = status::BootStage::Radio.led0_word();
    ws.show(&buf[..]).await;
    let mut radio = radio::init(
        spawner, p.PIO0, p.DMA_CH0, p.DMA_CH1, p.PIN_23, p.PIN_25, p.PIN_24, p.PIN_29,
    )
    .await;
    radio.control.gpio_set(0, true).await; // onboard LED on = radio alive
    log::info!("radio up (CYW43 Wi-Fi + BT firmware loaded)");

    // Boot complete — brief green LED-0 flash.
    buf[0] = status::BootStage::Complete.led0_word();
    ws.show(&buf[..]).await;
    Timer::after_millis(150).await;
    buf[0] = 0;

    // --- Play the selected pattern, or show "nofile" if none is playable ---
    let pbuf_ref = unsafe { &*addr_of!(PATTERN_BUF) };
    let pattern = pat_len.and_then(|n| leda::Pattern::parse(&pbuf_ref[..n]));
    match pattern {
        Some(pat) if pat.header.num_frames > 0 && pat.header.num_leds > 0 => {
            let n = (pat.header.num_leds as usize).min(MAX_LEDS);
            let fps = pat.header.fps.max(1) as u64;
            log::info!(
                "playing: {} leds, {} frames, {} fps, brightness {}",
                pat.header.num_leds,
                pat.header.num_frames,
                pat.header.fps,
                bright
            );
            let mut ticker = Ticker::every(Duration::from_micros(1_000_000 / fps));
            let mut frame = 0u32;
            // Serial heartbeat every ~5 s so the CDC log is verifiable anytime.
            let heartbeat = (fps as u32 * 5).max(1);
            let mut hb = 0u32;
            loop {
                if let Some(rgb) = pat.frame(frame) {
                    leda::fill_grb(rgb, &mut buf[..n], bright);
                    ws.show(&buf[..n]).await;
                }
                frame += 1;
                if frame >= pat.header.num_frames {
                    frame = 0;
                }
                hb += 1;
                if hb >= heartbeat {
                    hb = 0;
                    log::info!("alive — frame {}/{}", frame, pat.header.num_frames);
                }
                ticker.next().await;
            }
        }
        // Nothing selected/playable: LED0 red "nofile" pulse, strip dark.
        _ => {
            log::info!("no playable pattern selected — showing nofile");
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

/// Master brightness (0..=255) from `bright.txt` (a 0–100 percent), full if unset.
fn read_bright(fs: &fs::Fs) -> u8 {
    match fs.read::<8>(Path::from_bytes_with_nul(b"bright.txt\0").unwrap()) {
        Ok(v) => {
            let pct: u32 = core::str::from_utf8(&v)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(100);
            (pct.min(100) * 255 / 100) as u8
        }
        Err(_) => 255,
    }
}

/// Load the `selected.txt` pattern into `buf`; returns its byte length, or `None`
/// if nothing is selected / the file is missing / it doesn't fit `PATTERN_BUF`.
fn load_selected(fs: &fs::Fs, buf: &mut [u8]) -> Option<usize> {
    let sel = fs
        .read::<64>(Path::from_bytes_with_nul(b"selected.txt\0").unwrap())
        .ok()?;
    let name = core::str::from_utf8(&sel).ok()?.trim();
    if name.is_empty() {
        return None;
    }
    let mut namebuf = [0u8; 64];
    let path = fs::make_path(name, &mut namebuf)?;
    let n = fs.open_file_and_then(path, |f| f.read(buf)).ok()?;
    // n == buf.len() ⇒ the file filled the buffer and is likely truncated (too big).
    if n == 0 || n == buf.len() {
        return None;
    }
    Some(n)
}

/// Render a fatal boot-error code on LED 0 forever (strip otherwise dark).
async fn halt_error(ws: &mut Ws2812<'_, PIO1, 0>, buf: &mut [u32], err: status::BootError) -> ! {
    let mut ticker = Ticker::every(Duration::from_millis(33));
    loop {
        for w in buf.iter_mut() {
            *w = 0;
        }
        buf[0] = err.led0_word();
        ws.show(buf).await;
        ticker.next().await;
    }
}
