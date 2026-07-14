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
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use bt_hci::cmd::le::{
    LeAddDeviceToFilterAcceptList, LeClearFilterAcceptList, LeSetScanEnable, LeSetScanParams,
};
use bt_hci::controller::ControllerCmdSync;
use bt_hci::param::FilterDuplicates;
use embassy_time::{Duration, Instant, Timer};
use trouble_host::prelude::*;

/// The HCI scan commands a follower's `Central` needs from its controller.
trait ScanController:
    Controller
    + ControllerCmdSync<LeSetScanParams>
    + ControllerCmdSync<LeSetScanEnable>
    + ControllerCmdSync<LeClearFilterAcceptList>
    + ControllerCmdSync<LeAddDeviceToFilterAcceptList>
{
}
impl<C> ScanController for C where
    C: Controller
        + ControllerCmdSync<LeSetScanParams>
        + ControllerCmdSync<LeSetScanEnable>
        + ControllerCmdSync<LeClearFilterAcceptList>
        + ControllerCmdSync<LeAddDeviceToFilterAcceptList>
{
}

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

async fn run<C: ScanController>(controller: C, fs: &'static SharedFs) {
    // A fixed random address for now (a real device would use its BT MAC).
    let address: Address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    let mut resources: HostResources<C, DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let role = { CONTROL.lock().await.role };

    // A leader broadcasts the connectionless sync beacon (control of a leader is over
    // Wi-Fi); a follower scans + phase-locks to it; everyone else advertises
    // connectable device-info + GATT for the app.
    if role.is_leader() {
        let mut peripheral = stack.peripheral();
        let runner = stack.runner();
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

    if role.is_follower() {
        log::info!("BLE: follower — scanning + device advert");
        let group = { CONTROL.lock().await.group };
        let central = stack.central();
        let mut peripheral = stack.peripheral();
        let mut runner = stack.runner();
        let mut name: heapless::String<32> = heapless::String::new();
        {
            let c = CONTROL.lock().await;
            let _ = name.push_str(if c.name.is_empty() {
                "LED Animator"
            } else {
                c.name.as_str()
            });
        }
        let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
            name: name.as_str(),
            appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
        }))
        .unwrap();
        let handler = BeaconHandler { group };
        let mut scanner = Scanner::new(central);
        // One runner drives everything (beacon adv-reports + app connections). The
        // scan + PLL run alongside a connectable device-info advert so the app can
        // still find + control the follower while it phase-locks.
        let _ = join(runner.run_with_handler(&handler), async {
            let mut config = ScanConfig::default();
            config.active = false; // passive — the beacon is non-connectable
            config.interval = Duration::from_millis(30);
            config.window = Duration::from_millis(30);
            config.filter_duplicates = FilterDuplicates::Disabled;
            let _session = scanner.scan(&config).await;
            join(
                pll_loop(),
                device_serve(name.as_str(), &mut peripheral, &server, fs),
            )
            .await;
        })
        .await;
        return;
    }

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

    join(
        host_task(runner),
        device_serve(name.as_str(), &mut peripheral, &server, fs),
    )
    .await;
}

/// Advertise connectable device-info + serve GATT for the app, forever.
async fn device_serve<'values, 'server, C: Controller>(
    name: &'values str,
    peripheral: &mut Peripheral<'values, C, DefaultPacketPool>,
    server: &'server Server<'values>,
    fs: &'static SharedFs,
) {
    loop {
        match advertise(name, peripheral, server).await {
            Ok(conn) => {
                log::info!("BLE: connected");
                gatt_events(server, &conn, fs).await;
                log::info!("BLE: disconnected");
            }
            Err(_) => Timer::after_millis(500).await,
        }
    }
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

// ======================= Follower: scan + phase-lock =======================

/// A decoded leader sync beacon (type 0x02).
#[derive(Clone, Copy)]
struct Beacon {
    group: u8,
    frame: u32,
    ts: u32,
    flags: u8,
    rssi: i8,
}

/// Latest beacon from the scan event handler → the PLL loop.
static BEACON_SIG: Signal<CriticalSectionRawMutex, Beacon> = Signal::new();

/// Parse a beacon from raw advert bytes: an AD `0xFF` manufacturer block with
/// company `FFFF`, magic `LD`, type `0x02`, then the 13-byte payload.
fn parse_beacon(data: &[u8]) -> Option<Beacon> {
    let mut i = 0usize;
    while i + 1 < data.len() {
        let len = data[i] as usize;
        if len == 0 || i + 1 + len > data.len() {
            break;
        }
        let ad_type = data[i + 1];
        let ad = &data[i + 2..i + 1 + len];
        if ad_type == 0xFF
            && ad.len() >= 18
            && ad[0] == 0xFF
            && ad[1] == 0xFF
            && ad[2] == b'L'
            && ad[3] == b'D'
            && ad[4] == 0x02
        {
            let p = &ad[5..18];
            return Some(Beacon {
                group: p[0],
                frame: u32::from_le_bytes([p[1], p[2], p[3], p[4]]),
                ts: u32::from_le_bytes([p[5], p[6], p[7], p[8]]),
                flags: p[11],
                rssi: 0,
            });
        }
        i += 1 + len;
    }
    None
}

/// Delivers matching beacons to the PLL loop.
struct BeaconHandler {
    group: u8,
}

impl EventHandler for BeaconHandler {
    fn on_adv_reports(&self, mut it: LeAdvReportsIter<'_>) {
        while let Some(Ok(report)) = it.next() {
            if let Some(mut b) = parse_beacon(report.data) {
                if b.group == self.group {
                    b.rssi = report.rssi;
                    BEACON_SIG.signal(b);
                }
            }
        }
    }
}

#[inline]
fn fabs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}
/// `x mod n` in `[0, n)`.
#[inline]
fn wrapf(x: f32, n: f32) -> f32 {
    let mut e = x % n;
    if e < 0.0 {
        e += n;
    }
    e
}
/// Signed shortest error `target - local` on the ring of size `n` (in `[-n/2, n/2)`).
#[inline]
fn wrap_err(target: f32, local: f32, n: f32) -> f32 {
    let mut e = (target - local) % n;
    if e < 0.0 {
        e += n;
    }
    if e > n * 0.5 {
        e -= n;
    }
    e
}

/// The PI phase-locked loop (port of PiSyncTest/follower.py). Consumes beacons from
/// `BEACON_SIG` and publishes the locked frame via `state::set_follower_frame`.
async fn pll_loop() {
        const KP: f32 = 0.25; // phase gain (P)
        const KI: f32 = 0.03; // rate gain (I)
        const R_MIN: f32 = 1.0;
        const R_MAX: f32 = 240.0;
        const OFF_DECAY: f32 = 2.0; // clock-offset filter decay, ms/s
        const LOCK_TOL: f32 = 2.0; // |drift| under this (frames) = locked

        let mut phase = 0.0f32; // displayed frame (float)
        let mut r = 30.0f32; // rate (frames/s), tuned by the I term
        let mut nf = 300.0f32; // loop length, auto-detected from a wrap
        let mut off: Option<f32> = None; // clock offset (leader_ms - local_ms)
        let mut seeded = false;
        let mut prev_frame: Option<u32> = None;
        let mut prev_ts = 0u32;
        let mut playing = true;
        let mut drift = 0.0f32;
        let mut last_beacon_ms = Instant::now().as_millis();
        let mut prev_us = Instant::now().as_micros();
        let mut last_log_ms = Instant::now().as_millis();

        loop {
            let now = Instant::now();
            let nowms = now.as_millis() as f32;
            let now_us = now.as_micros();
            let dt = now_us.wrapping_sub(prev_us) as f32 / 1_000_000.0;
            prev_us = now_us;
            if playing {
                phase = wrapf(phase + dt * r, nf); // free-run at the current rate
            }

            if let Some(b) = BEACON_SIG.try_take() {
                last_beacon_ms = now.as_millis();
                playing = b.flags & 1 != 0;

                // Clock offset: max of (leader_ts - local) rejects packet-age noise;
                // slow decay tracks crystal skew.
                let osamp = b.ts as f32 - nowms;
                off = Some(match off {
                    None => osamp,
                    Some(o) => {
                        let decayed = o - OFF_DECAY * dt;
                        if osamp > decayed {
                            osamp
                        } else {
                            decayed
                        }
                    }
                });

                // Seed the rate + detect loop length from consecutive beacons.
                if let Some(pf) = prev_frame {
                    let dts = b.ts.wrapping_sub(prev_ts) as f32;
                    if dts > 0.0 && dts < 5000.0 {
                        let dfr = if b.frame >= pf {
                            (b.frame - pf) as f32
                        } else {
                            let nf_est = pf as f32 - b.frame as f32 + r * dts / 1000.0;
                            if nf_est > 10.0 && nf_est < 100000.0 {
                                nf = nf_est;
                            }
                            b.frame as f32 + nf - pf as f32
                        };
                        let meas = dfr / (dts / 1000.0);
                        if meas > 1.0 && meas < 240.0 && !seeded {
                            r = meas;
                            seeded = true;
                        }
                    }
                }
                prev_frame = Some(b.frame);
                prev_ts = b.ts;

                // Predict the leader's current frame and correct.
                let age = {
                    let a = nowms + off.unwrap_or(0.0) - b.ts as f32;
                    if a > 0.0 {
                        a
                    } else {
                        0.0
                    }
                };
                let target = wrapf(b.frame as f32 + r * age / 1000.0, nf);
                if !playing {
                    phase = target;
                } else {
                    drift = wrap_err(target, phase, nf);
                    if fabs(drift) > nf * 0.3 {
                        phase = target; // big jump (restart / new program): resync
                    } else {
                        phase = wrapf(phase + KP * drift, nf);
                        r += KI * drift;
                        if r < R_MIN {
                            r = R_MIN;
                        }
                        if r > R_MAX {
                            r = R_MAX;
                        }
                    }
                }
            }

            let searching =
                now.as_millis().wrapping_sub(last_beacon_ms) > 1000 || prev_frame.is_none();
            let locked = !searching && fabs(drift) <= LOCK_TOL;
            if searching {
                crate::state::set_follower_frame(crate::state::NO_LOCK);
            } else {
                let nfi = (nf as u32).max(1);
                crate::state::set_follower_frame((phase as u32) % nfi);
            }
            if now.as_millis().wrapping_sub(last_log_ms) > 1000 {
                last_log_ms = now.as_millis();
                log::info!(
                    "follower: phase={} drift(x10)={} R={} nf={} locked={} searching={}",
                    phase as u32,
                    (drift * 10.0) as i32,
                    r as u32,
                    nf as u32,
                    locked,
                    searching,
                );
            }
            Timer::after_millis(15).await;
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
