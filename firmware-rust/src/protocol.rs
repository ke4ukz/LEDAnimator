//! Transport-agnostic control command dispatch (docs/protocol.md). The SAME
//! command strings run over BLE now and Wi-Fi/TCP later. One line in, an optional
//! text reply out; setters mutate the shared `state::CONTROL` and the player picks
//! the change up on its next frame.
//!
//! This first cut covers the commands that work off the live control state (no
//! filesystem): PING/INFO/VERSION/PLATFORM/BRIGHT/SPEED/SOLID/OFF/PLAY/NAME(query)
//! and BOOTSEL. Filesystem-backed verbs (LIST/SELECT/DELETE/NAME set/FREE/MOREINFO)
//! and auth land with shared-fs access.

use crate::state::{Mode, CONTROL};
use core::fmt::Write;
use heapless::String;

pub const FW_VERSION: &str = "rust-0.1";
pub const PLATFORM: &str = "Raspberry Pi Pico W with RP2040";

/// A single-line reply (a BLE TX notification / a TCP line).
pub type Reply = String<160>;

fn lit(s: &str) -> Option<Reply> {
    let mut r = Reply::new();
    let _ = r.push_str(s);
    Some(r)
}

/// Handle one command line. Returns the reply, or `None` for no reply (e.g.
/// `BOOTSEL`, which resets the chip before it could send one).
pub async fn dispatch(line: &str) -> Option<Reply> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    let verb = parts.next().unwrap_or("");
    let mut vb: String<16> = String::new();
    for ch in verb.chars().take(16) {
        let _ = vb.push(ch.to_ascii_uppercase());
    }

    match vb.as_str() {
        "PING" => lit("OK"),

        "VERSION" => {
            let mut r = Reply::new();
            let _ = write!(r, "VERSION {}", FW_VERSION);
            Some(r)
        }
        "PLATFORM" => {
            let mut r = Reply::new();
            let _ = write!(r, "PLATFORM {}", PLATFORM);
            Some(r)
        }

        "INFO" => Some(info_line().await),

        "BRIGHT" => match parts.next().and_then(|s| s.parse::<i32>().ok()) {
            Some(n) => {
                let pct = n.clamp(0, 100) as u8;
                CONTROL.lock().await.bright = pct;
                let mut r = Reply::new();
                let _ = write!(r, "OK BRIGHT {}", pct);
                Some(r)
            }
            None => lit("ERR args"),
        },

        "SPEED" => match parts.next().and_then(|s| s.parse::<i32>().ok()) {
            Some(n) => {
                let sp = n.clamp(10, 400) as u16;
                CONTROL.lock().await.speed = sp;
                let mut r = Reply::new();
                let _ = write!(r, "OK SPEED {}", sp);
                Some(r)
            }
            None => lit("ERR args"),
        },

        "SOLID" => {
            let r = parts.next().and_then(|s| s.parse::<u16>().ok());
            let g = parts.next().and_then(|s| s.parse::<u16>().ok());
            let b = parts.next().and_then(|s| s.parse::<u16>().ok());
            match (r, g, b) {
                (Some(r), Some(g), Some(b)) => {
                    let mut c = CONTROL.lock().await;
                    c.solid = [(r & 255) as u8, (g & 255) as u8, (b & 255) as u8];
                    c.mode = Mode::Solid;
                    lit("OK SOLID")
                }
                _ => lit("ERR args"),
            }
        }

        "OFF" => {
            let mut c = CONTROL.lock().await;
            c.solid = [0, 0, 0];
            c.mode = Mode::Off;
            lit("OK OFF")
        }

        "PLAY" => {
            let mut c = CONTROL.lock().await;
            c.mode = Mode::Play;
            c.reload = true;
            lit("OK PLAY")
        }

        "NAME" => {
            // Query only for now; the persisting setter arrives with shared-fs access.
            let c = CONTROL.lock().await;
            let mut r = Reply::new();
            let _ = write!(r, "NAME {}", c.name.as_str());
            Some(r)
        }

        "BOOTSEL" => {
            // Reboot into the ROM USB bootloader (the RPI-RP2 drive) so a new UF2 can
            // be dropped on — matches the MicroPython BOOTSEL command (protocol.md
            // → Maintenance). The chip resets, so there is no reply.
            embassy_rp::rom_data::reset_to_usb_boot(0, 0);
            None
        }

        _ => lit("ERR unknown"),
    }
}

/// The lean `INFO` control-state line: `INFO <mode> <bright%> <speed%> <r> <g> <b> <file>`.
async fn info_line() -> Reply {
    let c = CONTROL.lock().await;
    let mut r = Reply::new();
    let _ = write!(
        r,
        "INFO {} {} {} {} {} {} {}",
        c.mode.as_str(),
        c.bright,
        c.speed,
        c.solid[0],
        c.solid[1],
        c.solid[2],
        c.file.as_str()
    );
    r
}
