//! CYW43 radio bring-up — loads the Wi-Fi + BT firmware over a PIO SPI on
//! **PIO0 + DMA_CH0/CH1** (WS2812 owns PIO1 + DMA_CH2). See docs/PORT.md → Phase D.
//!
//! Chip bring-up is a **blocking boot step** (`BootStage::Radio`, dim blue on
//! LED 0): a non-responsive chip hangs in `new_with_bluetooth`/`control.init`, and
//! LED 0 stays frozen blue — the "hang freezes on the stalled stage" behavior from
//! docs/led0-status.md. (Joining a Wi-Fi AP is a *separate*, background, non-fatal
//! step handled later — a dead chip is RMA, a bad Wi-Fi password is not.)
//!
//! Returns the handles later phases consume: `control` (Wi-Fi ops + onboard LED),
//! `net_device` (embassy-net, Phase F), `bt_device` (trouble-host BLE, Phase E).

use crate::Irqs;
#[cfg(feature = "bt")]
use cyw43::bluetooth::BtDriver;
#[cfg(feature = "wifi")]
use cyw43::NetDriver;
use cyw43::{Control, Cyw43439, State};
use crate::board::CYW43_CLOCK_DIVIDER;
use cyw43_pio::PioSpi;
use embassy_executor::Spawner;
use embassy_rp::gpio::{Level, Output};
use embassy_rp::peripherals::{DMA_CH0, DMA_CH1, PIN_23, PIN_24, PIN_25, PIN_29, PIO0};
use embassy_rp::pio::Pio;
use embassy_rp::{dma, Peri};
use static_cell::StaticCell;

type Spi = cyw43::SpiBus<Output<'static>, PioSpi<'static, PIO0, 0>>;

#[embassy_executor::task]
async fn runner_task(runner: cyw43::Runner<'static, Spi, Cyw43439>) -> ! {
    runner.run().await
}

/// Radio handles for the rest of the firmware. `net_device` exists only in a
/// `wifi` build, `bt_device` only in a `bt` build; `control` (Wi-Fi ops + onboard
/// LED) is common to both.
#[allow(dead_code)] // some handles go unused depending on the wifi/bt feature mix
pub struct Radio {
    pub control: Control<'static>,
    #[cfg(feature = "wifi")]
    pub net_device: NetDriver<'static>,
    #[cfg(feature = "bt")]
    pub bt_device: BtDriver<'static>,
}

/// Bring up the CYW43 (Wi-Fi + BT firmware + CLM). Spawns the background runner.
/// Blocking; hangs on a dead chip (LED 0 stays on the caller's `BootStage::Radio`).
#[allow(clippy::too_many_arguments)]
pub async fn init(
    spawner: Spawner,
    pio0: Peri<'static, PIO0>,
    dma0: Peri<'static, DMA_CH0>,
    dma1: Peri<'static, DMA_CH1>,
    pin_pwr: Peri<'static, PIN_23>,
    pin_cs: Peri<'static, PIN_25>,
    pin_dio: Peri<'static, PIN_24>,
    pin_clk: Peri<'static, PIN_29>,
) -> Radio {
    // fw/nvram must be 4-byte aligned (DMA); CLM is a plain byte slice. btfw is
    // loaded only in a `bt` build (see below).
    let fw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0.bin");
    let clm = include_bytes!("../cyw43-firmware/43439A0_clm.bin");
    let nvram = cyw43::aligned_bytes!("../cyw43-firmware/nvram_rp2040.bin");

    let pwr = Output::new(pin_pwr, Level::Low);
    let cs = Output::new(pin_cs, Level::High);
    let mut pio = Pio::new(pio0, Irqs);
    let spi = PioSpi::new(
        &mut pio.common,
        pio.sm0,
        CYW43_CLOCK_DIVIDER,
        pio.irq0,
        cs,
        pin_dio, // PIN_24 (DIO)
        pin_clk, // PIN_29 (CLK)
        dma::Channel::new(dma0, Irqs),
        dma::Channel::new(dma1, Irqs),
    );

    static STATE: StaticCell<State> = StaticCell::new();
    let state = STATE.init(State::new());

    // A `bt` build brings up the BT HCI (new_with_bluetooth, loads btfw); a
    // Wi-Fi-only build uses plain new() and never loads the BT firmware.
    #[cfg(feature = "bt")]
    let (net_device, bt_device, mut control, runner) = {
        let btfw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0_btfw.bin");
        cyw43::new_with_bluetooth(state, pwr, spi, fw, btfw, nvram).await
    };
    #[cfg(all(feature = "wifi", not(feature = "bt")))]
    let (net_device, mut control, runner) = cyw43::new(state, pwr, spi, fw, nvram).await;

    spawner.spawn(runner_task(runner).unwrap());
    control.init(clm).await;

    // BT-only build: new_with_bluetooth still hands back a net device we don't use.
    #[cfg(all(feature = "bt", not(feature = "wifi")))]
    let _ = net_device;

    Radio {
        control,
        #[cfg(feature = "wifi")]
        net_device,
        #[cfg(feature = "bt")]
        bt_device,
    }
}
