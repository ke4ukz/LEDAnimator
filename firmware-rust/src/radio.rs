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
use cyw43::bluetooth::BtDriver;
use cyw43::{Control, Cyw43439, NetDriver, State};
use cyw43_pio::{PioSpi, DEFAULT_CLOCK_DIVIDER};
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

/// Radio handles for the rest of the firmware.
#[allow(dead_code)] // net_device (Phase F) / bt_device (Phase E) wired as they land
pub struct Radio {
    pub control: Control<'static>,
    pub net_device: NetDriver<'static>,
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
    // fw/btfw/nvram must be 4-byte aligned (DMA); CLM is a plain byte slice.
    let fw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0.bin");
    let btfw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0_btfw.bin");
    let clm = include_bytes!("../cyw43-firmware/43439A0_clm.bin");
    let nvram = cyw43::aligned_bytes!("../cyw43-firmware/nvram_rp2040.bin");

    let pwr = Output::new(pin_pwr, Level::Low);
    let cs = Output::new(pin_cs, Level::High);
    let mut pio = Pio::new(pio0, Irqs);
    let spi = PioSpi::new(
        &mut pio.common,
        pio.sm0,
        DEFAULT_CLOCK_DIVIDER,
        pio.irq0,
        cs,
        pin_dio, // PIN_24 (DIO)
        pin_clk, // PIN_29 (CLK)
        dma::Channel::new(dma0, Irqs),
        dma::Channel::new(dma1, Irqs),
    );

    static STATE: StaticCell<State> = StaticCell::new();
    let state = STATE.init(State::new());
    let (net_device, bt_device, mut control, runner) =
        cyw43::new_with_bluetooth(state, pwr, spi, fw, btfw, nvram).await;
    spawner.spawn(runner_task(runner).unwrap());
    control.init(clm).await;

    Radio { control, net_device, bt_device }
}
