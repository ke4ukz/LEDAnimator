#![no_std]
#![no_main]

// CYW43 Wi-Fi + BLE COEXISTENCE spike — the migration decider (see PORT.md).
//
// Proves the single CYW43 radio does both at once in Rust, the way the
// MicroPython firmware already does. The proof is deliberately hardware-visible
// (no debug probe / no USB serial needed — the git embassy graph this must use
// doesn't play nice with embassy-usb, so telemetry is physical):
//
//   * BLE: trouble-host advertises a connectable peripheral named "coex-spike".
//     A phone BLE scanner (nRF Connect / LightBlue) should SEE it and be able to
//     connect — proof the BT side of the radio is live.
//   * Wi-Fi: a scan loop hammers `control.scan()` on its own task and pulses the
//     on-chip LED once per cycle (~0.25 Hz) — proof the Wi-Fi side keeps working.
//
// Both funnel through the one `cyw43::Runner`. If the LED keeps pulsing WHILE the
// phone still sees/holds the BLE advert, they coexist without deadlock — and the
// last big unknown on the Rust migration path is cleared.

use cyw43::Cyw43439;
use cyw43_pio::{PioSpi, DEFAULT_CLOCK_DIVIDER};
use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_rp::gpio::{Level, Output};
use embassy_rp::peripherals::{DMA_CH0, PIO0};
use embassy_rp::pio::Pio;
use embassy_rp::{bind_interrupts, dma};
use embassy_time::{Duration, Timer};
use panic_halt as _;
use static_cell::StaticCell;
use trouble_host::prelude::*;

bind_interrupts!(struct Irqs {
    PIO0_IRQ_0 => embassy_rp::pio::InterruptHandler<PIO0>;
    DMA_IRQ_0 => dma::InterruptHandler<DMA_CH0>, dma::InterruptHandler<embassy_rp::peripherals::DMA_CH1>;
});

#[embassy_executor::task]
async fn cyw43_task(
    runner: cyw43::Runner<'static, cyw43::SpiBus<Output<'static>, PioSpi<'static, PIO0, 0>>, Cyw43439>,
) -> ! {
    runner.run().await
}

// The Wi-Fi half of the coexistence test, on its own task (all 'static): pulse the
// LED on, scan (drives the Wi-Fi radio), pulse off, idle — forever, alongside BLE.
#[embassy_executor::task]
async fn wifi_scan_task(mut control: cyw43::Control<'static>) -> ! {
    loop {
        control.gpio_set(0, true).await;
        let mut scanner = control.scan(Default::default()).await;
        // Drain one full scan; the count doesn't matter, exercising the radio does.
        while let Some(_bss) = scanner.next().await {}
        drop(scanner);
        control.gpio_set(0, false).await;
        Timer::after(Duration::from_secs(2)).await;
    }
}

// ---- BLE (trouble-host) ----
const CONNECTIONS_MAX: usize = 1;
const L2CAP_CHANNELS_MAX: usize = 2;

#[gatt_server]
struct Server {
    battery_service: BatteryService,
}

#[gatt_service(uuid = service::BATTERY)]
struct BatteryService {
    #[characteristic(uuid = characteristic::BATTERY_LEVEL, read, notify, value = 42)]
    level: u8,
}

async fn ble_task<C: Controller, P: PacketPool>(mut runner: Runner<'_, C, P>) {
    loop {
        let _ = runner.run().await;
    }
}

async fn advertise<'values, 'server, C: Controller>(
    name: &'values str,
    peripheral: &mut Peripheral<'values, C, DefaultPacketPool>,
    server: &'server Server<'values>,
) -> Result<GattConnection<'values, 'server, DefaultPacketPool>, BleHostError<C::Error>> {
    let mut adv_data = [0u8; 31];
    let len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteLocalName(name.as_bytes()),
        ],
        &mut adv_data[..],
    )?;
    let advertiser = peripheral
        .advertise(
            &Default::default(),
            Advertisement::ConnectableScannableUndirected {
                adv_data: &adv_data[..len],
                scan_data: &[],
            },
        )
        .await?;
    let conn = advertiser.accept().await?.with_attribute_server(server)?;
    Ok(conn)
}

// The BLE half, as its own async fn so stack/resources/server/peripheral are all
// function-scoped locals and the join is the tail expression — the trouble example's
// exact shape, which sidesteps the drop-order lifetime tangle of inlining in main().
async fn run_ble<C: Controller>(controller: C) {
    let address: Address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    let mut resources: HostResources<_, DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let mut peripheral = stack.peripheral();
    let runner = stack.runner();

    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: "coex-spike",
        appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
    }))
    .unwrap();

    join(ble_task(runner), async {
        loop {
            match advertise("coex-spike", &mut peripheral, &server).await {
                Ok(conn) => gatt_task(&conn).await,
                Err(_) => Timer::after_millis(500).await,
            }
        }
    })
    .await;
}

async fn gatt_task<P: PacketPool>(conn: &GattConnection<'_, '_, P>) {
    loop {
        match conn.next().await {
            GattConnectionEvent::Disconnected { .. } => break,
            GattConnectionEvent::Gatt { event } => match event.accept() {
                Ok(reply) => reply.send().await,
                Err(_) => {}
            },
            _ => {}
        }
    }
}

static STATE: StaticCell<cyw43::State> = StaticCell::new();

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    let fw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0.bin");
    let btfw = cyw43::aligned_bytes!("../cyw43-firmware/43439A0_btfw.bin");
    let clm = include_bytes!("../cyw43-firmware/43439A0_clm.bin");
    let nvram = cyw43::aligned_bytes!("../cyw43-firmware/nvram_rp2040.bin");

    let pwr = Output::new(p.PIN_23, Level::Low);
    let cs = Output::new(p.PIN_25, Level::High);
    let mut pio = Pio::new(p.PIO0, Irqs);
    let spi = PioSpi::new(
        &mut pio.common,
        pio.sm0,
        DEFAULT_CLOCK_DIVIDER,
        pio.irq0,
        cs,
        p.PIN_24,
        p.PIN_29,
        dma::Channel::new(p.DMA_CH0, Irqs),
        dma::Channel::new(p.DMA_CH1, Irqs),
    );

    let state = STATE.init(cyw43::State::new());
    let (_net_device, bt_device, mut control, runner) =
        cyw43::new_with_bluetooth(state, pwr, spi, fw, btfw, nvram).await;
    spawner.spawn(cyw43_task(runner).unwrap());
    control.init(clm).await;

    // Wi-Fi scan loop on its own task, concurrent with the BLE loop.
    spawner.spawn(wifi_scan_task(control).unwrap());

    // BLE controller rides the same CYW43 over its HCI transport; run_ble() never returns.
    let controller: ExternalController<_, 10> = ExternalController::new(bt_device);
    run_ble(controller).await;
}
