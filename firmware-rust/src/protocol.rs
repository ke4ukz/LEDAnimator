//! Transport-agnostic control command dispatch (docs/protocol.md). The SAME
//! command strings run over BLE and Wi-Fi/TCP. Replies (one or many lines) are
//! written to a `LineSink` the transport provides — a BLE TX notification per line,
//! or a newline-terminated TCP line — so streamed responses (LIST) work everywhere.
//! Setters mutate the shared `state::CONTROL`; filesystem verbs use the shared fs.

use crate::fs::{make_path, SharedFs};
use crate::state::{Mode, CONTROL};
use core::fmt::Write;
use heapless::String;
use littlefs2::path::Path;

pub const FW_VERSION: &str = "rust-0.1";
pub const PLATFORM: &str = "Raspberry Pi Pico W with RP2040";

/// A single reply line's max length.
pub type Reply = String<160>;

/// Where replies go — one call per line. Implemented by each transport (BLE notify
/// / TCP write). `async` so a slow link back-pressures the streamer.
pub trait LineSink {
    async fn send(&mut self, line: &str);
}

fn cfg_path(nul: &[u8]) -> &Path {
    Path::from_bytes_with_nul(nul).unwrap()
}

/// Persist a small config file (best-effort).
async fn write_cfg(fs: &SharedFs, name: &[u8], contents: &[u8]) {
    let f = fs.lock().await;
    let _ = f.write(cfg_path(name), contents);
}

/// Handle one command line, sending any reply lines to `sink`.
pub async fn dispatch(line: &str, fs: &SharedFs, sink: &mut impl LineSink) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let verb_end = line.find(|c: char| c.is_whitespace()).unwrap_or(line.len());
    let (verb, rest) = line.split_at(verb_end);
    let arg = rest.trim();
    let mut vb: String<16> = String::new();
    for ch in verb.chars().take(16) {
        let _ = vb.push(ch.to_ascii_uppercase());
    }

    match vb.as_str() {
        "PING" => sink.send("OK").await,

        "VERSION" => reply(sink, format_args!("VERSION {}", FW_VERSION)).await,
        "PLATFORM" => reply(sink, format_args!("PLATFORM {}", PLATFORM)).await,

        "INFO" => {
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
            sink.send(&r).await;
        }

        "BRIGHT" => match arg.parse::<i32>() {
            Ok(n) => {
                let pct = n.clamp(0, 100) as u8;
                CONTROL.lock().await.bright = pct;
                let mut b: String<4> = String::new();
                let _ = write!(b, "{}", pct);
                write_cfg(fs, b"bright.txt\0", b.as_bytes()).await;
                reply(sink, format_args!("OK BRIGHT {}", pct)).await;
            }
            Err(_) => sink.send("ERR args").await,
        },

        "SPEED" => match arg.parse::<i32>() {
            Ok(n) => {
                let sp = n.clamp(10, 400) as u16;
                CONTROL.lock().await.speed = sp;
                reply(sink, format_args!("OK SPEED {}", sp)).await;
            }
            Err(_) => sink.send("ERR args").await,
        },

        "SOLID" => {
            let mut it = arg.split_whitespace();
            let r = it.next().and_then(|s| s.parse::<u16>().ok());
            let g = it.next().and_then(|s| s.parse::<u16>().ok());
            let b = it.next().and_then(|s| s.parse::<u16>().ok());
            match (r, g, b) {
                (Some(r), Some(g), Some(b)) => {
                    let solid = [(r & 255) as u8, (g & 255) as u8, (b & 255) as u8];
                    {
                        let mut c = CONTROL.lock().await;
                        c.solid = solid;
                        c.mode = Mode::Solid;
                    }
                    persist_state(fs, Mode::Solid, solid).await;
                    sink.send("OK SOLID").await;
                }
                _ => sink.send("ERR args").await,
            }
        }

        "OFF" => {
            {
                let mut c = CONTROL.lock().await;
                c.solid = [0, 0, 0];
                c.mode = Mode::Off;
            }
            persist_state(fs, Mode::Off, [0, 0, 0]).await;
            sink.send("OK OFF").await;
        }

        "PLAY" => {
            let solid = {
                let mut c = CONTROL.lock().await;
                c.mode = Mode::Play;
                c.reload = true;
                c.solid
            };
            persist_state(fs, Mode::Play, solid).await;
            sink.send("OK PLAY").await;
        }

        "MOREINFO" => {
            // Heavier device details, streamed as self-describing KEY <value> lines
            // (the app ignores keys it doesn't know + shows N/A for missing ones, so
            // fields we can't source yet — MACs, sync, power — are simply omitted).
            reply(sink, format_args!("VERSION {}", FW_VERSION)).await;
            let free = fs.lock().await.available_space().unwrap_or(0);
            reply(sink, format_args!("FREE {}", free)).await;
            reply(sink, format_args!("PLATFORM {}", PLATFORM)).await;
            sink.send("PIN 0").await; // data pin fixed at GP0
            sink.send("AUTH none").await; // no PIN support yet
            sink.send("ENDINFO").await;
        }

        "LIST" => list_patterns(fs, sink).await,

        "SELECT" => {
            if arg.is_empty() {
                sink.send("ERR args").await;
                return;
            }
            let exists = {
                let mut nb = [0u8; 64];
                match make_path(arg, &mut nb) {
                    Some(p) => fs.lock().await.exists(p),
                    None => false,
                }
            };
            if exists {
                write_cfg(fs, b"selected.txt\0", arg.as_bytes()).await;
                {
                    let mut c = CONTROL.lock().await;
                    c.file.set(arg);
                    c.mode = Mode::Play;
                    c.reload = true;
                }
                reply(sink, format_args!("OK SELECT {}", arg)).await;
            } else {
                sink.send("ERR no-file").await;
            }
        }

        "DELETE" => {
            if arg.is_empty() {
                sink.send("ERR args").await;
                return;
            }
            // Refuse to delete the active pattern.
            if CONTROL.lock().await.file.as_str() == arg {
                sink.send("ERR in-use").await;
                return;
            }
            let ok = {
                let mut nb = [0u8; 64];
                match make_path(arg, &mut nb) {
                    Some(p) => fs.lock().await.remove(p).is_ok(),
                    None => false,
                }
            };
            if ok {
                reply(sink, format_args!("OK DELETE {}", arg)).await;
            } else {
                sink.send("ERR no-file").await;
            }
        }

        "FREE" => {
            let free = fs.lock().await.available_space().unwrap_or(0);
            reply(sink, format_args!("FREE {}", free)).await;
        }

        "NAME" => {
            if arg.is_empty() {
                let c = CONTROL.lock().await;
                let mut r = Reply::new();
                let _ = write!(r, "NAME {}", c.name.as_str());
                sink.send(&r).await;
            } else {
                // Printable ASCII only, capped at 26 (the name rides the advert).
                let mut clean: String<26> = String::new();
                for ch in arg.chars() {
                    if (32..127).contains(&(ch as u32)) && clean.push(ch).is_err() {
                        break;
                    }
                }
                let trimmed = clean.as_str().trim();
                if trimmed.is_empty() {
                    sink.send("ERR args").await;
                } else {
                    write_cfg(fs, b"devicename.txt\0", trimmed.as_bytes()).await;
                    CONTROL.lock().await.name.set(trimmed);
                    // NB: the live BLE advert name updates on next reboot.
                    reply(sink, format_args!("OK NAME {}", trimmed)).await;
                }
            }
        }

        "BOOTSEL" => {
            // Reboot into the ROM USB bootloader (RPI-RP2) — the protocol.md
            // Maintenance command. The chip resets, so there is no reply.
            embassy_rp::rom_data::reset_to_usb_boot(0, 0);
        }

        _ => sink.send("ERR unknown").await,
    }
}

/// Stream the `.leda` pattern files: `LISTLEN <n>`, one `FILE <name>` each, `ENDLIST`.
async fn list_patterns(fs: &SharedFs, sink: &mut impl LineSink) {
    let mut names: heapless::Vec<String<48>, 64> = heapless::Vec::new();
    {
        let f = fs.lock().await;
        let _ = f.read_dir_and_then(cfg_path(b"/\0"), |rd| {
            for entry in rd.flatten() {
                if entry.file_type().is_file() {
                    let nm: &str = entry.file_name().as_ref();
                    if nm.ends_with(".leda") {
                        let mut s = String::new();
                        if s.push_str(nm).is_ok() {
                            let _ = names.push(s);
                        }
                    }
                }
            }
            Ok(())
        });
    }
    reply(sink, format_args!("LISTLEN {}", names.len())).await;
    for nm in &names {
        reply(sink, format_args!("FILE {}", nm.as_str())).await;
    }
    sink.send("ENDLIST").await;
}

/// Persist the playback mode + solid color to `state.txt` ("<mode> <r> <g> <b>").
async fn persist_state(fs: &SharedFs, mode: Mode, solid: [u8; 3]) {
    let mut s: String<32> = String::new();
    let _ = write!(s, "{} {} {} {}", mode.as_str(), solid[0], solid[1], solid[2]);
    write_cfg(fs, b"state.txt\0", s.as_bytes()).await;
}

/// Format + send a single reply line.
async fn reply(sink: &mut impl LineSink, args: core::fmt::Arguments<'_>) {
    let mut r = Reply::new();
    let _ = r.write_fmt(args);
    sink.send(&r).await;
}
