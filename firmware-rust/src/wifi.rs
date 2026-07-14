//! Wi-Fi — the station side (docs/protocol.md → Wi-Fi provisioning). The net stack
//! always comes up; a **manager** task joins on demand from `networks.txt` (written
//! at boot or by `WIFICONNECT`), so credentials can be provisioned live over the
//! control channel — no reboot, no mpremote. Once joined, the **TCP server on
//! :4550** runs the same `protocol::dispatch` as BLE.

use crate::fs::SharedFs;
use crate::protocol::{self, ConnState, LineSink};
use crate::state::{FixedStr, CONTROL};
use core::fmt::Write as _;
use cyw43::{Control, JoinOptions, NetDriver, ScanOptions};
use embassy_futures::select::{select, Either};
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

/// Credentials stashed by `WIFISSID`/`WIFIPASS`, committed by `WIFICONNECT`.
pub static PENDING: AsyncMutex<CriticalSectionRawMutex, (FixedStr<64>, FixedStr<64>)> =
    AsyncMutex::new((FixedStr::new(), FixedStr::new()));
/// Nudge the manager to (re)read `networks.txt` and (re)connect / disconnect.
pub static CONNECT_SIG: Signal<CriticalSectionRawMutex, ()> = Signal::new();
/// Current status for `WIFISTATUS` ("off" / "connecting" / "connected <ip>" / …).
pub static STATE: AsyncMutex<CriticalSectionRawMutex, FixedStr<48>> =
    AsyncMutex::new(FixedStr::new());

/// One `WIFISCAN` result.
#[derive(Clone, Copy)]
pub struct ScanEntry {
    pub rssi: i16,
    pub ssid: FixedStr<32>,
}

/// `WIFISCAN` handshake: dispatch signals REQ; the manager (which owns `Control`)
/// scans into RESULTS and signals DONE; dispatch streams RESULTS to the client.
pub static SCAN_REQ: Signal<CriticalSectionRawMutex, ()> = Signal::new();
pub static SCAN_DONE: Signal<CriticalSectionRawMutex, ()> = Signal::new();
pub static SCAN_RESULTS: AsyncMutex<CriticalSectionRawMutex, heapless::Vec<ScanEntry, 24>> =
    AsyncMutex::new(heapless::Vec::new());

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
        // Wait for a reconnect request (re-evaluate creds) or a scan request. A scan
        // keeps us in this inner loop; a connect request breaks out to re-join.
        loop {
            match select(CONNECT_SIG.wait(), SCAN_REQ.wait()).await {
                Either::First(_) => break,
                Either::Second(_) => run_scan(&mut control).await,
            }
        }
    }
}

/// Scan for nearby networks into `SCAN_RESULTS` (deduped by SSID), then signal DONE.
async fn run_scan(control: &mut Control<'static>) {
    let mut results: heapless::Vec<ScanEntry, 24> = heapless::Vec::new();
    let mut scanner = control.scan(ScanOptions::default()).await;
    while let Some(bss) = scanner.next().await {
        let len = (bss.ssid_len as usize).min(32);
        if len == 0 {
            continue;
        }
        let ssid = match core::str::from_utf8(&bss.ssid[..len]) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Keep the strongest per SSID; skip if we've already seen it.
        if results.iter().any(|e| e.ssid.as_str() == ssid) {
            continue;
        }
        let mut fs = FixedStr::new();
        fs.set(ssid);
        if results.push(ScanEntry { rssi: bss.rssi, ssid: fs }).is_err() {
            break; // buffer full
        }
    }
    drop(scanner);
    *SCAN_RESULTS.lock().await = results;
    SCAN_DONE.signal(());
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
            // Hostname suffix = the 3-byte device id (hex), so the app matches this
            // Wi-Fi device to the same device seen over BLE.
            let mut reply: heapless::String<96> = heapless::String::new();
            let _ = write!(
                reply,
                "LEDA leda-{} {}",
                crate::state::device_id_hex().as_str(),
                name.as_str()
            );
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

/// Accept a control connection on :4550 and run each command through `dispatch`.
/// Pooled so several clients (e.g. the macOS + iOS apps) can connect at once — each
/// pool instance owns one socket and its own buffers.
#[embassy_executor::task(pool_size = 3)]
pub async fn tcp_task(stack: Stack<'static>, fs: &'static SharedFs) {
    stack.wait_config_up().await;

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

/// Max bulk-upload size (a `.leda`) — matches the player's pattern buffer.
const UPLOAD_MAX: usize = 128 * 1024;

/// Parse `UPLOAD <length> <name>`; the name is the rest of the line (may have spaces).
fn parse_upload(line: &str) -> Option<(usize, heapless::String<64>)> {
    let line = line.trim();
    let sp = line.find(' ')?;
    if !line[..sp].eq_ignore_ascii_case("UPLOAD") {
        return None;
    }
    let rest = line[sp + 1..].trim_start();
    let sp2 = rest.find(' ')?;
    let len: usize = rest[..sp2].parse().ok()?;
    let name = rest[sp2 + 1..].trim();
    if name.is_empty() {
        return None;
    }
    let mut n = heapless::String::new();
    n.push_str(name).ok()?;
    Some((len, n))
}

/// Bulk `.leda` upload (docs/protocol.md): reply `OK UPLOAD`, stream `len` raw bytes,
/// verify the `LEDA` magic, save. `initial` is any binary already read after the line.
async fn handle_upload(
    sock: &mut TcpSocket<'_>,
    fs: &'static SharedFs,
    initial: &[u8],
    len: usize,
    name: &str,
) {
    if len == 0 || len > UPLOAD_MAX {
        let _ = sock.write_all(b"ERR size\n").await;
        return;
    }
    let mut nb = [0u8; 64];
    if crate::fs::make_path(name, &mut nb).is_none() {
        let _ = sock.write_all(b"ERR name\n").await;
        return;
    }
    let _ = sock.write_all(b"OK UPLOAD\n").await;

    // Stream to flash in small chunks (no big RAM buffer): the first chunk creates
    // the file (fs.write), the rest append via write_chunk at the running offset.
    let mut src = initial;
    let mut chunk = [0u8; 512];
    let mut got = 0usize;
    let mut first = true;
    let mut aborted = false;
    while got < len {
        let want = (len - got).min(chunk.len());
        let mut filled = 0;
        if !src.is_empty() {
            let t = src.len().min(want);
            chunk[..t].copy_from_slice(&src[..t]);
            src = &src[t..];
            filled = t;
        }
        while filled < want {
            match sock.read(&mut chunk[filled..want]).await {
                Ok(0) | Err(_) => {
                    aborted = true;
                    break;
                }
                Ok(k) => filled += k,
            }
        }
        if aborted {
            break;
        }
        // Validate the LEDA magic on the first chunk before writing anything.
        if first && (filled < 4 || &chunk[0..4] != b"LEDA") {
            let _ = sock.write_all(b"ERR badfile\n").await;
            return;
        }
        let mut nb2 = [0u8; 64];
        let ok = match crate::fs::make_path(name, &mut nb2) {
            Some(p) => {
                let f = fs.lock().await;
                if first {
                    f.write(p, &chunk[..filled]).is_ok()
                } else {
                    f.write_chunk(p, &chunk[..filled], littlefs2::io::OpenSeekFrom::Start(got as u32))
                        .is_ok()
                }
            }
            None => false,
        };
        if !ok {
            let _ = sock.write_all(b"ERR open\n").await;
            return;
        }
        first = false;
        got += filled;
    }
    let _ = sock
        .write_all(if aborted { b"ERR badfile\n" } else { b"OK UPLOADED\n" })
        .await;
}

/// One connection: line-buffered read → dispatch → newline-terminated reply, with a
/// binary-mode escape for `UPLOAD`.
async fn serve(sock: &mut TcpSocket<'_>, fs: &'static SharedFs) {
    let mut line: heapless::String<200> = heapless::String::new();
    let mut conn_state = ConnState::new(); // per-connection auth state
    let mut buf = [0u8; 128];
    // Watch for state changes made by *other* clients (the macOS app moved a slider
    // while iOS is connected) so we can push a fresh INFO and keep every app in sync.
    let mut watch = crate::state::state_watch_receiver();
    loop {
        // Race a read against a state-change signal. On a change, push INFO; otherwise
        // process the bytes read. `changed()` is only armed if we got a watcher slot.
        let n = {
            let read = sock.read(&mut buf);
            let changed = async {
                match watch {
                    Some(ref mut w) => w.changed().await,
                    None => core::future::pending().await,
                }
            };
            match select(read, changed).await {
                Either::First(Ok(0)) | Either::First(Err(_)) => return,
                Either::First(Ok(n)) => n,
                Either::Second(_) => {
                    let mut sink = TcpSink { sock: &mut *sock };
                    protocol::send_info(&mut sink).await;
                    continue;
                }
            }
        };
        let mut i = 0;
        while i < n {
            let b = buf[i];
            if b == b'\n' {
                if !line.is_empty() {
                    if let Some((ulen, uname)) = parse_upload(line.as_str()) {
                        // Switch to binary mode; any bytes after the newline are the
                        // start of the stream. handle_upload consumes the rest.
                        handle_upload(sock, fs, &buf[i + 1..n], ulen, uname.as_str()).await;
                        line.clear();
                        break;
                    }
                    let mut sink = TcpSink { sock: &mut *sock };
                    protocol::dispatch(line.as_str(), fs, &mut sink, &mut conn_state).await;
                    line.clear();
                }
            } else if b != b'\r' && line.push(b as char).is_err() {
                line.clear(); // overflow — drop the oversized line
            }
            i += 1;
        }
    }
}
