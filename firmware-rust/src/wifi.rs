//! Wi-Fi — auto-join from `networks.txt` + a TCP control server on **:4550** that
//! runs the SAME `protocol::dispatch` as BLE (docs/protocol.md → Wi-Fi). Once the
//! station is up, the app can drive the device over a plain socket:
//!
//! ```text
//!   nc <device-ip> 4550
//!   PING
//! ```
//!
//! The UDP `LEDADISCOVER` responder is a follow-up (see docs/PORT.md).

use crate::protocol;
use cyw43::{Control, JoinOptions, NetDriver};
use embassy_net::tcp::TcpSocket;
use embassy_net::{Runner, Stack};
use embassy_time::{Duration, Timer};
use embedded_io_async::Write;

/// The control port (matches the MicroPython firmware + the app).
pub const PORT: u16 = 4550;

/// The embassy-net background runner (drives smoltcp over the CYW43 net driver).
#[embassy_executor::task]
pub async fn net_runner_task(mut runner: Runner<'static, NetDriver<'static>>) -> ! {
    runner.run().await
}

/// Join the configured network, retrying forever (a Wi-Fi failure is non-fatal —
/// the pattern keeps playing regardless).
#[embassy_executor::task]
pub async fn wifi_task(
    mut control: Control<'static>,
    ssid: heapless::String<64>,
    pass: heapless::String<64>,
) {
    loop {
        log::info!("wifi: joining \"{}\"", ssid.as_str());
        match control.join(ssid.as_str(), JoinOptions::new(pass.as_bytes())).await {
            Ok(()) => {
                log::info!("wifi: associated");
                return;
            }
            Err(_) => {
                log::info!("wifi: join failed, retry in 5s");
                Timer::after_secs(5).await;
            }
        }
    }
}

/// Accept control connections on :4550 and run each command through `dispatch`.
#[embassy_executor::task]
pub async fn tcp_task(stack: Stack<'static>) {
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
        serve(&mut sock).await;
        sock.abort();
        let _ = sock.flush().await;
        log::info!("tcp: client disconnected");
    }
}

/// One connection: line-buffered read → dispatch → newline-terminated reply.
async fn serve(sock: &mut TcpSocket<'_>) {
    let mut line: heapless::String<200> = heapless::String::new();
    let mut buf = [0u8; 128];
    loop {
        let n = match sock.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' {
                if !line.is_empty() {
                    if let Some(resp) = protocol::dispatch(line.as_str()).await {
                        let _ = sock.write_all(resp.as_bytes()).await;
                        let _ = sock.write_all(b"\n").await;
                    }
                    line.clear();
                }
            } else if b != b'\r' && line.push(b as char).is_err() {
                line.clear(); // overflow — drop the oversized line
            }
        }
    }
}
