//! BLE control channel — a Nordic-UART-style service over the CYW43 HCI
//! (trouble-host). Scanners filter on the LED Animator **service UUID**; a client
//! writes a command line to **RX** and replies arrive as **TX** notifications
//! (docs/protocol.md → Bluetooth LE). Command handling is the shared, transport-
//! agnostic `protocol::dispatch`.

use crate::fs::SharedFs;
use crate::protocol::{self, LineSink};
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

/// A `LineSink` that notifies each reply line on the TX characteristic.
struct BleSink<'a, 'stack, 'server, P: PacketPool> {
    tx: &'a Characteristic<heapless::Vec<u8, 200>>,
    conn: &'a GattConnection<'stack, 'server, P>,
}

impl<P: PacketPool> LineSink for BleSink<'_, '_, '_, P> {
    async fn send(&mut self, line: &str) {
        let _ = self.tx.notify_raw(self.conn, line.as_bytes(), false).await;
    }
}

/// The BLE control task: owns the CYW43 BT HCI and runs the host forever.
#[embassy_executor::task]
pub async fn ble_task(bt_device: BtDriver<'static>, fs: &'static SharedFs) {
    let controller: ExternalController<BtDriver<'static>, 10> = ExternalController::new(bt_device);
    run(controller, fs).await;
}

async fn run<C: Controller>(controller: C, fs: &'static SharedFs) {
    // A fixed random address for now (a real device would use its BT MAC).
    let address: Address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    let mut resources: HostResources<C, DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let mut peripheral = stack.peripheral();
    let runner = stack.runner();

    // A leader broadcasts the connectionless sync beacon (control is over Wi-Fi);
    // everyone else advertises connectable device-info + GATT for the app.
    if { CONTROL.lock().await.role }.is_leader() {
        log::info!("BLE: leader — broadcasting sync beacon");
        let mut seq: u8 = 0;
        join(host_task(runner), async {
            loop {
                let mut adv = [0u8; 31];
                let len = build_beacon(&mut adv, seq).await;
                let params = AdvertisementParameters::default();
                match peripheral
                    .advertise(
                        &params,
                        Advertisement::NonconnectableNonscannableUndirected { adv_data: &adv[..len] },
                    )
                    .await
                {
                    // Hold the advertiser ~100 ms (a few-Hz refresh), then rebuild with
                    // a fresh frame/ts/seq. Dropping `_adv` stops it before the next round.
                    Ok(_adv) => Timer::after_millis(100).await,
                    Err(_) => Timer::after_millis(200).await,
                }
                seq = seq.wrapping_add(1);
            }
        })
        .await;
        return;
    }

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
                    gatt_events(&server, &conn, fs).await;
                    log::info!("BLE: disconnected");
                }
                Err(_) => Timer::after_millis(500).await,
            }
        }
    })
    .await;
}

/// Build the sync-beacon advertising data (docs/sync-beacon.md, byte-exact with the
/// Pi rig): flags + 16-bit UUID `0x1EDA` + manufacturer(`FFFF` + `LD` + type `0x02` +
/// `<group,frame,ts_ms,program,bright,flags,seq>`). Returns the length.
async fn build_beacon(adv: &mut [u8; 31], seq: u8) -> usize {
    let (group, program, bright255, playing) = {
        let c = CONTROL.lock().await;
        (
            c.group,
            c.program,
            (c.bright as u16 * 255 / 100) as u8,
            c.mode == crate::state::Mode::Play,
        )
    };
    let (frame, ts) = crate::state::position();
    let mut mfg = [0u8; 16];
    mfg[0] = b'L';
    mfg[1] = b'D';
    mfg[2] = 0x02; // type: sync beacon
    mfg[3] = group;
    mfg[4..8].copy_from_slice(&frame.to_le_bytes());
    mfg[8..12].copy_from_slice(&ts.to_le_bytes());
    mfg[12] = program;
    mfg[13] = bright255;
    mfg[14] = if playing { 0x01 } else { 0x00 }; // bit0 = playing (bit1 = teardown)
    mfg[15] = seq;
    AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids16(&[[0xda, 0x1e]]),
            AdStructure::ManufacturerSpecificData {
                company_identifier: 0xFFFF,
                payload: &mfg,
            },
        ],
        adv,
    )
    .unwrap_or(0)
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
    // Manufacturer data: company 0xFFFF + the 3-byte device id (the app matches this
    // to the Wi-Fi hostname suffix to dedup one device across BLE + Wi-Fi).
    let dev_id = crate::state::device_id_bytes();
    let mut adv = [0u8; 31];
    let adv_len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids128(&[SVC_UUID_LE]),
            AdStructure::ManufacturerSpecificData {
                company_identifier: 0xFFFF,
                payload: &dev_id,
            },
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
async fn gatt_events<P: PacketPool>(
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, P>,
    fs: &'static SharedFs,
) {
    let rx_handle = server.nus.rx.handle;
    let tx = &server.nus.tx;
    let mut conn_state = protocol::ConnState::new(); // per-connection auth state
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
                // Dispatch; replies notify on TX (possibly several lines for LIST).
                if !cmd.is_empty() {
                    let mut sink = BleSink { tx, conn };
                    protocol::dispatch(cmd.as_str(), fs, &mut sink, &mut conn_state).await;
                }
            }
            _ => {}
        }
    }
}
