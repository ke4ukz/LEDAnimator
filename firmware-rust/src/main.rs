#![no_std]
#![no_main]

mod ble; // BLE control channel (trouble-host NUS)
mod fs;
mod leda;
mod panic; // registers the #[panic_handler] (LED-0 red flutter)
mod protocol; // transport-agnostic command dispatch
mod radio; // CYW43 Wi-Fi + BT bring-up
mod recovery; // power-cycle recovery ritual
mod state; // shared control state (mode / brightness / speed)
mod status;
mod usb; // picotool reset interface + CDC serial logger
mod wifi; // Wi-Fi join + TCP control server
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
// Strip span used by SOLID/OFF when no pattern is loaded (so those still light a
// reasonable length on a device with no selected pattern to source a LED count).
const DEFAULT_LEDS: usize = 60;
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
    static STORAGE: StaticCell<fs::FlashStorage> = StaticCell::new();
    static ALLOC: StaticCell<littlefs2::fs::Allocation<fs::FlashStorage>> = StaticCell::new();
    static FS: StaticCell<fs::SharedFs> = StaticCell::new();
    let storage = STORAGE.init(fs::FlashStorage::new(flash));
    let alloc = ALLOC.init(Filesystem::allocate());
    // `fs` is now a `&'static` mutex shared by the player, recovery, and the control
    // dispatch (BLE + Wi-Fi). Lock it briefly for each op.
    let fs: &'static fs::SharedFs = match Filesystem::mount(alloc, storage) {
        Ok(f) => FS.init(embassy_sync::mutex::Mutex::new(f)),
        // Fatal: no readable storage — show the RMA code on LED 0, forever.
        Err(_) => halt_error(&mut ws, buf, status::errors::FS_MOUNT_FAILED).await,
    };

    // --- Power-cycle recovery ritual — bump the counter BEFORE radio bring-up, so
    // it climbs even if a dead radio would hang the boot. Feedback is rendered now
    // (before the ~0.7 s radio init) so a rapid cycler sees it immediately. ---
    let recovery_action = {
        let g = fs.lock().await;
        recovery::bump_and_act(&g)
    };
    match recovery_action {
        recovery::Action::None => {}
        recovery::Action::Climb(n) => {
            // "You're at N" — light N dim-white pixels for ~0.6 s.
            let lit = (n as usize).min(MAX_LEDS);
            for w in buf.iter_mut() {
                *w = 0;
            }
            let dim_white = ws2812::grb_word(40, 40, 40);
            for w in buf[..lit].iter_mut() {
                *w = dim_white;
            }
            ws.show(&buf[..lit]).await;
            Timer::after_millis(600).await;
            for w in buf[..lit].iter_mut() {
                *w = 0;
            }
            ws.show(&buf[..lit]).await;
        }
        action => {
            if let Some(kind) = action.recovery() {
                // Whole-strip flash (~1.5 s). Show the full buffer so the entire
                // physical strip flashes regardless of its length.
                status::paint_recovery(kind, buf);
                ws.show(&buf[..]).await;
                log::info!(
                    "recovery: {}",
                    match kind {
                        status::Recovery::PinCleared => "PIN cleared (cyan)",
                        status::Recovery::FactoryReset => "factory reset (magenta)",
                    }
                );
                Timer::after_millis(1500).await;
                for w in buf.iter_mut() {
                    *w = 0;
                }
                ws.show(&buf[..]).await;
            }
        }
    }

    // --- Config: master brightness + the selected pattern (loaded into PATTERN_BUF) ---
    let bright = {
        let g = fs.lock().await;
        read_bright(&g)
    };
    let pat_len = {
        let pbuf = unsafe { &mut *addr_of_mut!(PATTERN_BUF) };
        let g = fs.lock().await;
        load_selected(&g, pbuf)
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

    // Start the BLE control channel (owns the CYW43 BT HCI + the shared fs for
    // filesystem-backed commands like LIST/SELECT).
    spawner.spawn(ble::ble_task(radio.bt_device, fs).unwrap());

    // --- Wi-Fi: auto-join if networks.txt has credentials (non-fatal; the pattern
    // plays regardless). Brings up embassy-net + the TCP control server on :4550. ---
    let creds = {
        let g = fs.lock().await;
        read_wifi_creds(&g)
    };
    if let Some((ssid, pass)) = creds {
        static NET_RES: StaticCell<embassy_net::StackResources<4>> = StaticCell::new();
        let net_res = NET_RES.init(embassy_net::StackResources::new());
        let (stack, net_runner) = embassy_net::new(
            radio.net_device,
            embassy_net::Config::dhcpv4(Default::default()),
            net_res,
            0x0123_4567_89ab_cdef,
        );
        spawner.spawn(wifi::net_runner_task(net_runner).unwrap());
        spawner.spawn(wifi::wifi_task(radio.control, ssid, pass).unwrap());
        spawner.spawn(wifi::tcp_task(stack, fs).unwrap());
        log::info!("wifi: configured — bringing up");
    } else {
        log::info!("wifi: no networks.txt — skipping");
    }

    // Boot complete — brief green LED-0 flash.
    buf[0] = status::BootStage::Complete.led0_word();
    ws.show(&buf[..]).await;
    Timer::after_millis(150).await;
    buf[0] = 0;

    // We reached the run loop — the boot completed instead of being interrupted, so
    // commit the recovery counter back to 0 (COMMIT_MS = 0: "let it start once" clears).
    {
        let g = fs.lock().await;
        recovery::commit(&g);
    }

    // --- State-driven player: seed shared control from config, then render per the
    // current mode each frame. Setter commands (BLE/Wi-Fi) mutate `state::CONTROL`. ---
    let sel = {
        let g = fs.lock().await;
        read_cfg_line(&g, b"selected.txt\0")
    };
    let nm = {
        let g = fs.lock().await;
        read_cfg_line(&g, b"devicename.txt\0")
    };
    {
        let mut c = state::CONTROL.lock().await;
        c.bright = bright;
        if let Some(s) = sel {
            c.file.set(s.as_str());
        }
        if let Some(s) = nm {
            c.name.set(s.as_str());
        }
    }
    log::info!("player: starting (bright {})", bright);

    // The initially-selected pattern (borrows PATTERN_BUF; reloaded on SELECT).
    let mut pattern = {
        let pbuf_ref = unsafe { &*addr_of!(PATTERN_BUF) };
        pat_len.and_then(|n| leda::Pattern::parse(&pbuf_ref[..n]))
    };

    let mut frame = 0u32;
    let mut last_hb = embassy_time::Instant::now();
    loop {
        let snap = state::take_snapshot().await;

        // SELECT/PROGRAM changed the selection — reload the pattern from flash.
        // Drop the old borrow BEFORE mutating PATTERN_BUF (aliasing safety).
        if snap.reload {
            let _ = pattern.take(); // drop the borrow BEFORE mutating PATTERN_BUF
            let newlen = {
                let pbuf = unsafe { &mut *addr_of_mut!(PATTERN_BUF) };
                let g = fs.lock().await;
                load_selected(&g, pbuf)
            };
            let pbuf_ref = unsafe { &*addr_of!(PATTERN_BUF) };
            pattern = newlen.and_then(|n| leda::Pattern::parse(&pbuf_ref[..n]));
            frame = 0;
        }

        // Strip length from the pattern, or a default so SOLID/OFF light something.
        let n = pattern
            .as_ref()
            .map(|p| (p.header.num_leds as usize).min(MAX_LEDS))
            .unwrap_or(DEFAULT_LEDS);

        // Brightness percent (0..=100) → 0..=255 for the render path.
        let bright255 = (snap.bright as u16 * 255 / 100) as u8;

        match snap.mode {
            state::Mode::Off => {
                for w in buf[..n].iter_mut() {
                    *w = 0;
                }
                ws.show(&buf[..n]).await;
                Timer::after_millis(50).await;
            }
            state::Mode::Solid => {
                let [r, g, b] = snap.solid;
                let scale = |c: u8| ((c as u16 * bright255 as u16) / 255) as u8;
                let word = ws2812::grb_word(scale(r), scale(g), scale(b));
                for w in buf[..n].iter_mut() {
                    *w = word;
                }
                ws.show(&buf[..n]).await;
                Timer::after_millis(50).await;
            }
            state::Mode::Play => match &pattern {
                Some(pat) if pat.header.num_frames > 0 && pat.header.num_leds > 0 => {
                    if let Some(rgb) = pat.frame(frame) {
                        leda::fill_grb(rgb, &mut buf[..n], bright255);
                        ws.show(&buf[..n]).await;
                    }
                    frame += 1;
                    if frame >= pat.header.num_frames {
                        frame = 0;
                    }
                    // Speed-scaled frame period: speed% of the authored fps.
                    let eff = ((pat.header.fps.max(1) as u32) * snap.speed.max(1) as u32 / 100).max(1);
                    Timer::after_micros((1_000_000 / eff) as u64).await;
                }
                // Nothing playable: LED 0 red "nofile" pulse, rest dark.
                _ => {
                    for w in buf.iter_mut() {
                        *w = 0;
                    }
                    buf[0] = status::led0_word(status::Status::Nofile);
                    ws.show(&buf[..]).await;
                    Timer::after_millis(33).await;
                }
            },
        }

        if last_hb.elapsed().as_millis() >= 5000 {
            last_hb = embassy_time::Instant::now();
            log::info!("alive — frame {}", frame);
        }
    }
}

/// Read a small single-line config file (trimmed) into a heapless string, or None.
fn read_cfg_line(fs: &fs::Fs, name_nul: &[u8]) -> Option<heapless::String<64>> {
    let v = fs.read::<64>(Path::from_bytes_with_nul(name_nul).ok()?).ok()?;
    let s = core::str::from_utf8(&v).ok()?.trim();
    if s.is_empty() {
        return None;
    }
    let mut out = heapless::String::new();
    out.push_str(s).ok()?;
    Some(out)
}

/// Read Wi-Fi credentials from `networks.txt` (line 1 = SSID, line 2 = password).
/// `None` if the file is missing or has no SSID.
fn read_wifi_creds(fs: &fs::Fs) -> Option<(heapless::String<64>, heapless::String<64>)> {
    let v = fs.read::<160>(Path::from_bytes_with_nul(b"networks.txt\0").ok()?).ok()?;
    let s = core::str::from_utf8(&v).ok()?;
    let mut lines = s.split('\n');
    let ssid = lines.next()?.trim();
    if ssid.is_empty() {
        return None;
    }
    let pass = lines.next().unwrap_or("").trim_end_matches(['\r', '\n']);
    let mut ss = heapless::String::new();
    ss.push_str(ssid).ok()?;
    let mut pp = heapless::String::new();
    pp.push_str(pass).ok()?;
    Some((ss, pp))
}

/// Master brightness **percent** (0..=100) from `bright.txt`, full if unset.
fn read_bright(fs: &fs::Fs) -> u8 {
    match fs.read::<8>(Path::from_bytes_with_nul(b"bright.txt\0").unwrap()) {
        Ok(v) => {
            let pct: u32 = core::str::from_utf8(&v)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(100);
            pct.min(100) as u8
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
