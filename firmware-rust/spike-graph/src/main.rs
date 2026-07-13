//! Phase-A graph spike — a compile+link proof, not a runnable app.
//!
//! Goal: confirm that ONE dependency graph resolves and links for thumbv6m with
//! ALL of the migration's pieces present at once — the part that was never proven
//! together before:
//!   * cyw43 (Wi-Fi+BT) + cyw43-pio            — radio
//!   * trouble-host + bt-hci                    — BLE host over the cyw43 HCI
//!   * embassy-net                              — Wi-Fi TCP/UDP stack
//!   * embassy-usb + embassy-usb-logger         — THE thing that broke on the old
//!                                                coex rev (embedded-io skew)
//!   * littlefs2 (our disk-2.1 fork) + tinyrlibc + delog — storage
//!
//! The trait-critical seam is `cyw43 bt_device -> ExternalController` (this is
//! where the old "bt-hci Transport not satisfied" errors lived) and the
//! embassy-rp `usb::Driver` feeding embassy-usb-logger (the embedded-io seam).
//! We construct both so the compiler must actually check the bounds. It is wired
//! to the real GPIOs so it *could* run, but the point is that it builds.

#![no_std]
#![no_main]

use cyw43::Cyw43439;
use cyw43_pio::PioSpi;
use embassy_executor::Spawner;
use embassy_net::{Config as NetConfig, StackResources};
use embassy_rp::gpio::{Level, Output};
use embassy_rp::peripherals::{DMA_CH0, DMA_CH1, PIO0, USB};
use embassy_rp::pio::{InterruptHandler as PioInterruptHandler, Pio};
use embassy_rp::usb::{Driver as UsbDriver, InterruptHandler as UsbInterruptHandler};
use embassy_rp::{bind_interrupts, dma};
use littlefs2::fs::Filesystem;
use littlefs2::path::Path;
use static_cell::StaticCell;
use trouble_host::prelude::ExternalController;
use {panic_halt as _};

bind_interrupts!(struct Irqs {
    PIO0_IRQ_0 => PioInterruptHandler<PIO0>;
    DMA_IRQ_0 => dma::InterruptHandler<DMA_CH0>, dma::InterruptHandler<DMA_CH1>;
    USBCTRL_IRQ => UsbInterruptHandler<USB>;
});

type Cyw43Spi = cyw43::SpiBus<Output<'static>, PioSpi<'static, PIO0, 0>>;

#[embassy_executor::task]
async fn cyw43_task(runner: cyw43::Runner<'static, Cyw43Spi, Cyw43439>) -> ! {
    runner.run().await
}

#[embassy_executor::task]
async fn net_task(
    mut runner: embassy_net::Runner<'static, cyw43::NetDriver<'static>>,
) -> ! {
    runner.run().await
}

#[embassy_executor::task]
async fn logger_task(driver: UsbDriver<'static, USB>) {
    embassy_usb_logger::run!(1024, log::LevelFilter::Info, driver);
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    // --- USB: driver -> embassy-usb-logger (the embedded-io seam that broke) ---
    let usb_driver = UsbDriver::new(p.USB, Irqs);
    spawner.spawn(logger_task(usb_driver).unwrap());

    // --- CYW43 radio bring-up (mirrors trouble's rp-pico-w example) ---
    let fw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0.bin");
    let clm = cyw43::aligned_bytes!("../cyw43-firmware/43439A0_clm.bin");
    let btfw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0_btfw.bin");
    let nvram = cyw43::aligned_bytes!("../cyw43-firmware/nvram_rp2040.bin");

    let pwr = Output::new(p.PIN_23, Level::Low);
    let cs = Output::new(p.PIN_25, Level::High);
    let mut pio = Pio::new(p.PIO0, Irqs);
    let spi = PioSpi::new(
        &mut pio.common,
        pio.sm0,
        cyw43_pio::DEFAULT_CLOCK_DIVIDER,
        pio.irq0,
        cs,
        p.PIN_24,
        p.PIN_29,
        dma::Channel::new(p.DMA_CH0, Irqs),
        dma::Channel::new(p.DMA_CH1, Irqs),
    );

    static STATE: StaticCell<cyw43::State> = StaticCell::new();
    let state = STATE.init(cyw43::State::new());
    let (net_device, bt_device, mut control, runner) =
        cyw43::new_with_bluetooth(state, pwr, spi, fw, btfw, nvram).await;
    spawner.spawn(cyw43_task(runner).unwrap());
    control.init(clm).await;

    // --- BLE host over the cyw43 HCI (the bt-hci trait seam) ---
    let _controller: ExternalController<_, 10> = ExternalController::new(bt_device);

    // --- Wi-Fi stack over the cyw43 net driver ---
    static RESOURCES: StaticCell<StackResources<4>> = StaticCell::new();
    let resources = RESOURCES.init(StackResources::new());
    let (_stack, net_runner) =
        embassy_net::new(net_device, NetConfig::dhcpv4(Default::default()), resources, 0x1234_5678);
    spawner.spawn(net_task(net_runner).unwrap());

    // --- Storage: reference littlefs (our fork) so it links in this graph too ---
    let _ = keep_littlefs_linked;

    loop {
        control.gpio_set(0, true).await;
        embassy_time::Timer::after_millis(500).await;
        control.gpio_set(0, false).await;
        embassy_time::Timer::after_millis(500).await;
    }
}

/// Never called — exists so littlefs2 (fork) + tinyrlibc are part of this link.
#[allow(dead_code)]
fn keep_littlefs_linked(fs: &Filesystem<'_, DummyStorage>) -> bool {
    fs.read::<8>(Path::from_bytes_with_nul(b"x\0").unwrap()).is_ok()
}

/// Minimal Storage so `Filesystem` monomorphizes (no real flash in this spike).
struct DummyStorage;
impl littlefs2::driver::Storage for DummyStorage {
    const READ_SIZE: usize = 256;
    const WRITE_SIZE: usize = 256;
    const BLOCK_SIZE: usize = 4096;
    const BLOCK_COUNT: usize = 16;
    type CACHE_SIZE = littlefs2::consts::U256;
    type LOOKAHEAD_SIZE = littlefs2::consts::U16;
    fn read(&mut self, _off: usize, _buf: &mut [u8]) -> littlefs2::io::Result<usize> {
        Err(littlefs2::io::Error::IO)
    }
    fn write(&mut self, _off: usize, _data: &[u8]) -> littlefs2::io::Result<usize> {
        Err(littlefs2::io::Error::IO)
    }
    fn erase(&mut self, _off: usize, _len: usize) -> littlefs2::io::Result<usize> {
        Err(littlefs2::io::Error::IO)
    }
}
