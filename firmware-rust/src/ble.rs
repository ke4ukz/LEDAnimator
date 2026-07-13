//! BLE control channel — a Nordic-UART-style service over the CYW43 HCI
//! (trouble-host). Scanners filter on the LED Animator **service UUID**; a client
//! writes a command line to **RX** and replies arrive as **TX** notifications
//! (docs/protocol.md → Bluetooth LE). Command handling is the shared, transport-
//! agnostic `protocol::dispatch`.

use crate::protocol;
use crate::state::CONTROL;
use cyw43::bluetooth::BtDriver;
use embassy_futures::join::join;
use embassy_time::Timer;
use trouble_host::prelude::*;

const CONNECTIONS_MAX: usize = 1;
const L2CAP_CHANNELS_MAX: usize = 2; // signalling + ATT

/// Service UUID `4C454441-0001-4000-8000-4C4544415254`, little-endian for the
/// advertisement (BLE sends 128-bit UUIDs LSB-first).
const SVC_UUID_LE: [u8; 16] = [
    0x54, 0x52, 0x41, 0x44, 0x45, 0x4c, 0x00, 0x80, 0x00, 0x40, 0x01, 0x00, 0x41, 0x44, 0x45, 0x4c,
];

// GATT server: the LED Animator NUS service.
#[gatt_server]
struct Server {
    nus: NusService,
}

#[gatt_service(uuid = "4C454441-0001-4000-8000-4C4544415254")]
struct NusService {
    /// Commands are written here (one line per write).
    #[characteristic(uuid = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E", write, write_without_response)]
    rx: heapless::Vec<u8, 200>,
    /// Replies + unsolicited state broadcasts arrive here as notifications.
    #[characteristic(uuid = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E", notify)]
    tx: heapless::Vec<u8, 200>,
}

/// The BLE control task: owns the CYW43 BT HCI and runs the host forever.
#[embassy_executor::task]
pub async fn ble_task(bt_device: BtDriver<'static>) {
    let controller: ExternalController<BtDriver<'static>, 10> = ExternalController::new(bt_device);
    run(controller).await;
}

async fn run<C: Controller>(controller: C) {
    // A fixed random address for now (a real device would use its BT MAC).
    let address: Address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    let mut resources: HostResources<C, DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let mut peripheral = stack.peripheral();
    let runner = stack.runner();

    // Device name for GAP + the advert scan response (default if none set yet).
    let mut name: heapless::String<32> = heapless::String::new();
    {
        let c = CONTROL.lock().await;
        if c.name.is_empty() {
            let _ = name.push_str("LED Animator");
        } else {
            let _ = name.push_str(c.name.as_str());
        }
    }

    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: name.as_str(),
        appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
    }))
    .unwrap();

    log::info!("BLE: advertising as \"{}\"", name.as_str());

    join(host_task(runner), async {
        loop {
            match advertise(name.as_str(), &mut peripheral, &server).await {
                Ok(conn) => {
                    log::info!("BLE: connected");
                    gatt_events(&server, &conn).await;
                    log::info!("BLE: disconnected");
                }
                Err(_) => Timer::after_millis(500).await,
            }
        }
    })
    .await;
}

/// The trouble-host background runner (must run for the whole BLE lifetime).
async fn host_task<C: Controller, P: PacketPool>(mut runner: Runner<'_, C, P>) {
    loop {
        let _ = runner.run().await;
    }
}

/// Advertise: service UUID in the advert (for filtering), name in the scan response.
/// Lifetimes split (`'values` = stack/adv data, `'server` = the server borrow) so
/// the server isn't forced to live as long as the stack (drop-order).
async fn advertise<'values, 'server, C: Controller>(
    name: &'values str,
    peripheral: &mut Peripheral<'values, C, DefaultPacketPool>,
    server: &'server Server<'values>,
) -> Result<GattConnection<'values, 'server, DefaultPacketPool>, BleHostError<C::Error>> {
    let mut adv = [0u8; 31];
    let adv_len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids128(&[SVC_UUID_LE]),
        ],
        &mut adv[..],
    )?;
    let mut scan = [0u8; 31];
    let scan_len = AdStructure::encode_slice(
        &[AdStructure::CompleteLocalName(name.as_bytes())],
        &mut scan[..],
    )?;
    let advertiser = peripheral
        .advertise(
            &Default::default(),
            Advertisement::ConnectableScannableUndirected {
                adv_data: &adv[..adv_len],
                scan_data: &scan[..scan_len],
            },
        )
        .await?;
    let conn = advertiser.accept().await?.with_attribute_server(server)?;
    Ok(conn)
}

/// Handle GATT events for one connection: RX writes → dispatch → TX notify.
async fn gatt_events<P: PacketPool>(server: &Server<'_>, conn: &GattConnection<'_, '_, P>) {
    let rx_handle = server.nus.rx.handle;
    let tx = &server.nus.tx;
    loop {
        match conn.next().await {
            GattConnectionEvent::Disconnected { .. } => break,
            GattConnectionEvent::Gatt { event } => {
                // Capture a command written to RX before accepting the transaction.
                let mut cmd: heapless::String<200> = heapless::String::new();
                if let GattEvent::Write(w) = &event {
                    if w.handle() == rx_handle {
                        w.with_data(|_off, data| {
                            if let Ok(s) = core::str::from_utf8(data) {
                                let _ = cmd.push_str(s);
                            }
                        });
                    }
                }
                // Ack the ATT transaction.
                match event.accept() {
                    Ok(reply) => reply.send().await,
                    Err(_) => {}
                }
                // Dispatch and notify the reply, if any.
                if !cmd.is_empty() {
                    if let Some(resp) = protocol::dispatch(cmd.as_str()).await {
                        let _ = tx.notify_raw(conn, resp.as_bytes(), false).await;
                    }
                }
            }
            _ => {}
        }
    }
}
