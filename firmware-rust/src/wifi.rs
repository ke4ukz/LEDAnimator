//! Wi-Fi — the station side (docs/protocol.md → Wi-Fi provisioning). The net stack
//! always comes up; a **manager** task joins on demand from `networks.txt` (written
//! at boot or by `WIFICONNECT`), so credentials can be provisioned live over the
//! control channel — no reboot, no mpremote. Once joined, the **TCP server on
//! :4550** runs the same `protocol::dispatch` as BLE.

use crate::fs::SharedFs;
use crate::protocol::{self, ConnState, LineSink};
use crate::state::{FixedStr, CONTROL};
use core::fmt::Write as _;
use cyw43::{Control, JoinOptions, NetDriver};
use embassy_net::tcp::TcpSocket;
use embassy_net::udp::{PacketMetadata, UdpSocket};
use embassy_net::{Runner, Stack};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex as AsyncMutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Timer};
use embedded_io_async::Write;
use littlefs2::path::Path;

pub const PORT: u16 = 4550;
/// Wi-Fi hostname reported in the `LEDADISCOVER` reply. TODO: make per-device
/// (suffix = the BLE manufacturer-data device id) so the app dedups BLE vs Wi-Fi.
const HOSTNAME: &str = "ledanimator";

/// Credentials stashed by `WIFISSID`/`WIFIPASS`, committed by `WIFICONNECT`.
pub static PENDING: AsyncMutex<CriticalSectionRawMutex, (FixedStr<64>, FixedStr<64>)> =
    AsyncMutex::new((FixedStr::new(), FixedStr::new()));
/// Nudge the manager to (re)read `networks.txt` and (re)connect / disconnect.
pub static CONNECT_SIG: Signal<CriticalSectionRawMutex, ()> = Signal::new();
/// Current status for `WIFISTATUS` ("off" / "connecting" / "connected <ip>" / …).
pub static STATE: AsyncMutex<CriticalSectionRawMutex, FixedStr<48>> =
    AsyncMutex::new(FixedStr::new());

async fn set_state(s: &str) {
    STATE.lock().await.set(s);
}

/// The `WIFISTATUS` reply line.
pub async fn status_line() -> heapless::String<64> {
    let g = STATE.lock().await;
    let s = g.as_str();
    let mut r = heapless::String::new();
    let _ = write!(r, "WIFI {}", if s.is_empty() { "off" } else { s });
    r
}

fn networks_path() -> &'static Path {
    Path::from_bytes_with_nul(b"networks.txt\0").unwrap()
}

/// Credentials from `networks.txt` (line 1 SSID, line 2 password), or `None`.
async fn read_creds(fs: &SharedFs) -> Option<(heapless::String<64>, heapless::String<64>)> {
    let v = fs.lock().await.read::<160>(networks_path()).ok()?;
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

/// The embassy-net background runner (drives smoltcp over the CYW43 net driver).
#[embassy_executor::task]
pub async fn net_runner_task(mut runner: Runner<'static, NetDriver<'static>>) -> ! {
    runner.run().await
}

/// Owns the CYW43 `Control`; joins on demand from `networks.txt` and tracks state.
#[embassy_executor::task]
pub async fn manager_task(
    mut control: Control<'static>,
    stack: Stack<'static>,
    fs: &'static SharedFs,
) {
    loop {
        match read_creds(fs).await {
            Some((ssid, pass)) => {
                log::info!("wifi: joining \"{}\"", ssid.as_str());
                set_state("connecting").await;
                match control.join(ssid.as_str(), JoinOptions::new(pass.as_bytes())).await {
                    Ok(()) => match with_timeout(Duration::from_secs(20), stack.wait_config_up()).await {
                        Ok(()) => {
                            let mut line: heapless::String<48> = heapless::String::new();
                            if let Some(cfg) = stack.config_v4() {
                                let _ = write!(line, "connected {}", cfg.address.address());
                            } else {
                                let _ = write!(line, "connected");
                            }
                            STATE.lock().await.set(line.as_str());
                            log::info!("wifi: {}", line.as_str());
                        }
                        Err(_) => {
                            set_state("no-ip").await;
                            log::info!("wifi: joined but no DHCP lease");
                        }
                    },
                    Err(_) => {
                        set_state("failed").await;
                        log::info!("wifi: join failed");
                    }
                }
            }
            None => {
                let _ = control.leave().await;
                set_state("off").await;
            }
        }
        // Block until a WIFICONNECT / WIFIFORGET asks us to re-evaluate.
        CONNECT_SIG.wait().await;
    }
}

/// UDP discovery: reply `LEDA <hostname> <name>` to a `LEDADISCOVER` broadcast on
/// :4550, so the app finds the device (and its IP, from the packet source) on Wi-Fi.
#[embassy_executor::task]
pub async fn discover_task(stack: Stack<'static>) {
    stack.wait_config_up().await;
    let mut rx_meta = [PacketMetadata::EMPTY; 8];
    let mut tx_meta = [PacketMetadata::EMPTY; 8];
    let mut rx_buf = [0u8; 256];
    let mut tx_buf = [0u8; 256];
    let mut sock = UdpSocket::new(stack, &mut rx_meta, &mut rx_buf, &mut tx_meta, &mut tx_buf);
    if sock.bind(PORT).is_err() {
        log::info!("udp: bind :{} failed", PORT);
        return;
    }
    log::info!("udp: LEDADISCOVER responder on :{}", PORT);
    loop {
        let (is_discover, endpoint) = sock
            .recv_from_with(|data, meta| (data.starts_with(b"LEDADISCOVER"), meta.endpoint))
            .await;
        if is_discover {
            let mut name: heapless::String<32> = heapless::String::new();
            {
                let c = CONTROL.lock().await;
                let _ = name.push_str(if c.name.is_empty() {
                    "LED Animator"
                } else {
                    c.name.as_str()
                });
            }
            let mut reply: heapless::String<96> = heapless::String::new();
            let _ = write!(reply, "LEDA {} {}", HOSTNAME, name.as_str());
            let _ = sock.send_to(reply.as_bytes(), endpoint).await;
        }
    }
}

/// A `LineSink` that writes each reply line + newline to the TCP socket.
struct TcpSink<'a, 'b> {
    sock: &'a mut TcpSocket<'b>,
}

impl LineSink for TcpSink<'_, '_> {
    async fn send(&mut self, line: &str) {
        let _ = self.sock.write_all(line.as_bytes()).await;
        let _ = self.sock.write_all(b"\n").await;
    }
}

/// Accept control connections on :4550 and run each command through `dispatch`.
#[embassy_executor::task]
pub async fn tcp_task(stack: Stack<'static>, fs: &'static SharedFs) {
    stack.wait_config_up().await;
    if let Some(cfg) = stack.config_v4() {
        log::info!("wifi: IP {} — TCP control on :{}", cfg.address.address(), PORT);
    }

    let mut rx = [0u8; 512];
    let mut tx = [0u8; 512];
    loop {
        let mut sock = TcpSocket::new(stack, &mut rx, &mut tx);
        sock.set_timeout(Some(Duration::from_secs(60)));
        if sock.accept(PORT).await.is_err() {
            Timer::after_millis(200).await;
            continue;
        }
        log::info!("tcp: client connected");
        serve(&mut sock, fs).await;
        sock.abort();
        let _ = sock.flush().await;
        log::info!("tcp: client disconnected");
    }
}

/// One connection: line-buffered read → dispatch → newline-terminated reply.
async fn serve(sock: &mut TcpSocket<'_>, fs: &'static SharedFs) {
    let mut line: heapless::String<200> = heapless::String::new();
    let mut conn_state = ConnState::new(); // per-connection auth state
    let mut buf = [0u8; 128];
    loop {
        let n = match sock.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        for i in 0..n {
            let b = buf[i];
            if b == b'\n' {
                if !line.is_empty() {
                    let mut sink = TcpSink { sock: &mut *sock };
                    protocol::dispatch(line.as_str(), fs, &mut sink, &mut conn_state).await;
                    line.clear();
                }
            } else if b != b'\r' && line.push(b as char).is_err() {
                line.clear(); // overflow — drop the oversized line
            }
        }
    }
}
