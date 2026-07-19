//! Transport-agnostic control command dispatch (docs/protocol.md). The SAME
//! command strings run over BLE and Wi-Fi/TCP. Replies (one or many lines) are
//! written to a `LineSink` the transport provides — a BLE TX notification per line,
//! or a newline-terminated TCP line — so streamed responses (LIST) work everywhere.
//! Setters mutate the shared `state::CONTROL`; filesystem verbs use the shared fs.

use crate::fs::{make_path, SharedFs};
use crate::state::{notify_state_change, Mode, CONTROL};
use core::fmt::Write;
use core::sync::atomic::{AtomicU32, Ordering};
use embassy_time::Instant;
use heapless::String;
use littlefs2::path::Path;
use sha2::{Digest, Sha256};

pub const FW_VERSION: &str = "rust-0.1";
use crate::board::PLATFORM;

/// After a failed LOGIN, further attempts are refused for this long (non-blocking
/// rate limit — a casual brute-force deterrent). Shared across connections.
const AUTH_RETRY_MS: u32 = 5000;
static AUTH_FAIL_AT: AtomicU32 = AtomicU32::new(0);

/// Per-connection auth state — forgotten on disconnect (each connection gets a
/// fresh one). A PIN in `auth.txt` locks the device; a connection must LOGIN
/// (challenge-response) before any command but PING/INFO/LOGIN.
pub struct ConnState {
    authed: bool,
    nonce: String<16>,
}

impl ConnState {
    pub fn new() -> Self {
        Self {
            authed: false,
            nonce: String::new(),
        }
    }
}

impl Default for ConnState {
    fn default() -> Self {
        Self::new()
    }
}

fn valid_pin(s: &str) -> bool {
    (4..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// The set PIN from `auth.txt`, or `None` if the device is open.
async fn read_pin(fs: &SharedFs) -> Option<String<8>> {
    let v = fs.lock().await.read::<8>(cfg_path(b"auth.txt\0")).ok()?;
    let s = core::str::from_utf8(&v).ok()?.trim();
    if valid_pin(s) {
        let mut p = String::new();
        p.push_str(s).ok()?;
        Some(p)
    } else {
        None
    }
}

/// An 8-byte challenge nonce (16 hex chars) from the ring-oscillator RNG.
fn gen_nonce() -> String<16> {
    let mut rng = embassy_rp::clocks::RoscRng;
    let mut s = String::new();
    let _ = write!(s, "{:08x}{:08x}", rng.next_u32(), rng.next_u32());
    s
}

/// `sha256(pin + nonce)` as lowercase hex — the expected `LOGIN` hash.
fn expected_hash(pin: &str, nonce: &str) -> String<64> {
    let mut h = Sha256::new();
    h.update(pin.as_bytes());
    h.update(nonce.as_bytes());
    let mut s = String::new();
    for byte in h.finalize() {
        let _ = write!(s, "{:02x}", byte);
    }
    s
}

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

/// Copy a `&str` into an owned heapless string (to drop a lock before using it).
fn heapless_of(s: &str) -> String<64> {
    let mut out = String::new();
    let _ = out.push_str(s);
    out
}

/// Persist a small config file (best-effort).
async fn write_cfg(fs: &SharedFs, name: &[u8], contents: &[u8]) {
    let f = fs.lock().await;
    let _ = f.write(cfg_path(name), contents);
}

/// Handle one command line, sending any reply lines to `sink`. `conn` carries the
/// per-connection auth state.
pub async fn dispatch(line: &str, fs: &SharedFs, sink: &mut impl LineSink, conn: &mut ConnState) {
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

    // --- Auth gate: a locked device (auth.txt set) answers only PING, INFO (hands
    // back a login challenge), and LOGIN until this connection authenticates. ---
    let pin = read_pin(fs).await;
    if let Some(ref pin) = pin {
        if !conn.authed {
            match vb.as_str() {
                "LOGIN" => {
                    do_login(arg, pin, conn, sink).await;
                    return;
                }
                "PING" => {
                    sink.send("OK").await;
                    return;
                }
                "INFO" => {
                    conn.nonce = gen_nonce();
                    reply(sink, format_args!("NEEDPIN {}", conn.nonce.as_str())).await;
                    return;
                }
                _ => {
                    sink.send("ERR auth").await;
                    return;
                }
            }
        }
    }

    match vb.as_str() {
        "PING" => sink.send("OK").await,

        "LOGIN" => {
            // Past the gate (open, or already authed) → idempotent OK.
            conn.authed = true;
            sink.send("OK LOGIN").await;
        }

        "SETPASS" => {
            if arg.is_empty() {
                sink.send("ERR args").await;
            } else if pin.is_some() {
                sink.send("ERR exists").await; // CLEARPASS first, then set a new one
            } else if !valid_pin(arg) {
                sink.send("ERR args").await;
            } else {
                write_cfg(fs, b"auth.txt\0", arg.as_bytes()).await;
                conn.authed = true; // keep the setter logged in
                sink.send("OK SETPASS").await;
            }
        }

        "CLEARPASS" => {
            {
                let f = fs.lock().await;
                let _ = f.remove(cfg_path(b"auth.txt\0"));
            }
            sink.send("OK CLEARPASS").await;
        }

        "VERSION" => reply(sink, format_args!("VERSION {}", FW_VERSION)).await,
        "PLATFORM" => reply(sink, format_args!("PLATFORM {}", PLATFORM)).await,

        "INFO" => send_info(sink).await,

        "BRIGHT" => match arg.parse::<i32>() {
            Ok(n) => {
                let pct = n.clamp(0, 100) as u8;
                CONTROL.lock().await.bright = pct;
                let mut b: String<4> = String::new();
                let _ = write!(b, "{}", pct);
                write_cfg(fs, b"bright.txt\0", b.as_bytes()).await;
                notify_state_change();
                reply(sink, format_args!("OK BRIGHT {}", pct)).await;
            }
            Err(_) => sink.send("ERR args").await,
        },

        "SPEED" => match arg.parse::<i32>() {
            Ok(n) => {
                let sp = n.clamp(10, 400) as u16;
                CONTROL.lock().await.speed = sp;
                notify_state_change();
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
                    notify_state_change();
                    sink.send("OK SOLID").await;
                }
                _ => sink.send("ERR args").await,
            }
        }

        "OFF" => {
            // Keep the set solid color — OFF renders black regardless (the player
            // zeroes the strip in Mode::Off), so returning to SOLID restores the
            // color instead of coming back black. Persist the live color so it also
            // survives a reboot.
            let solid = {
                let mut c = CONTROL.lock().await;
                c.mode = Mode::Off;
                c.solid
            };
            persist_state(fs, Mode::Off, solid).await;
            notify_state_change();
            sink.send("OK OFF").await;
        }

        // White-balance calibration: the per-channel "canonical white" gains. No
        // arg = query. The app shows solid white and drags these live (broadcast so
        // any client stays in sync); persisted so the calibration survives a reboot.
        "WHITEBAL" => {
            if arg.is_empty() {
                let w = CONTROL.lock().await.white;
                reply(sink, format_args!("WHITEBAL {} {} {}", w[0], w[1], w[2])).await;
            } else {
                let mut it = arg.split_whitespace();
                let r = it.next().and_then(|s| s.parse::<u16>().ok());
                let g = it.next().and_then(|s| s.parse::<u16>().ok());
                let b = it.next().and_then(|s| s.parse::<u16>().ok());
                match (r, g, b) {
                    (Some(r), Some(g), Some(b)) => {
                        let w = [(r & 255) as u8, (g & 255) as u8, (b & 255) as u8];
                        CONTROL.lock().await.white = w;
                        let mut buf: String<16> = String::new();
                        let _ = write!(buf, "{} {} {}", w[0], w[1], w[2]);
                        write_cfg(fs, b"whitebal.txt\0", buf.as_bytes()).await;
                        notify_state_change();
                        reply(sink, format_args!("OK WHITEBAL {} {} {}", w[0], w[1], w[2])).await;
                    }
                    _ => sink.send("ERR args").await,
                }
            }
        }

        // Render-stage feature toggles "<gamma> <white> <dither>" (each 0/1), for
        // A/B'ing the perceptual steps on the same pattern. No arg = query. Persisted +
        // broadcast. (Dither engages a high-refresh sub-loop; default off.)
        "RENDER" => {
            let bit = |m: u8| if crate::state::render_flags() & m != 0 { 1 } else { 0 };
            if arg.is_empty() {
                reply(
                    sink,
                    format_args!(
                        "RENDER {} {} {}",
                        bit(crate::state::FX_GAMMA),
                        bit(crate::state::FX_WHITE),
                        bit(crate::state::FX_DITHER)
                    ),
                )
                .await;
            } else {
                let mut it = arg.split_whitespace();
                let on = |t: Option<&str>| t == Some("1");
                let (g, w, d) = (on(it.next()), on(it.next()), on(it.next()));
                let mut flags = 0u8;
                if g {
                    flags |= crate::state::FX_GAMMA;
                }
                if w {
                    flags |= crate::state::FX_WHITE;
                }
                if d {
                    flags |= crate::state::FX_DITHER;
                }
                crate::state::set_render_flags(flags);
                let mut b: String<8> = String::new();
                let _ = write!(b, "{} {} {}", g as u8, w as u8, d as u8);
                write_cfg(fs, b"render.txt\0", b.as_bytes()).await;
                notify_state_change();
                reply(sink, format_args!("OK RENDER {} {} {}", g as u8, w as u8, d as u8)).await;
            }
        }

        "PLAY" => {
            let solid = {
                let mut c = CONTROL.lock().await;
                c.mode = Mode::Play;
                c.reload = true;
                c.solid
            };
            persist_state(fs, Mode::Play, solid).await;
            notify_state_change();
            sink.send("OK PLAY").await;
        }

        "MOREINFO" => {
            // Heavier device details, streamed as self-describing KEY <value> lines
            // (the app ignores keys it doesn't know + shows N/A for missing ones).
            reply(sink, format_args!("VERSION {}", FW_VERSION)).await;
            let free = fs.lock().await.available_space().unwrap_or(0);
            reply(sink, format_args!("FREE {}", free)).await;
            let m = crate::state::mac_bytes();
            reply(
                sink,
                format_args!(
                    "WIFIMAC {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                    m[0], m[1], m[2], m[3], m[4], m[5]
                ),
            )
            .await;
            let bt = crate::state::ble_address();
            reply(
                sink,
                format_args!(
                    "BTMAC {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                    bt[0], bt[1], bt[2], bt[3], bt[4], bt[5]
                ),
            )
            .await;
            reply(sink, format_args!("HOSTNAME leda-{}", crate::state::device_id_hex().as_str())).await;
            reply(sink, format_args!("PLATFORM {}", PLATFORM)).await;
            reply(sink, format_args!("PIN {}", crate::DATA_PIN_GP)).await; // fixed at build (GP0)
            {
                let c = CONTROL.lock().await;
                reply(sink, format_args!("ROLE {}", role_name(c.role))).await;
                reply(sink, format_args!("GROUP {}", c.group)).await;
                reply(sink, format_args!("PROGRAM {}", program_of(c.file.as_str()))).await;
            }
            reply(
                sink,
                format_args!("AUTH {}", if read_pin(fs).await.is_some() { "set" } else { "none" }),
            )
            .await;
            sink.send("POWER unknown 0").await; // no power sensing yet (Pico W VSYS caveat)
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
                // Selecting a pattern clears any factory-reset de-group override, so
                // the newly-selected pattern's header role (incl. leader) takes effect
                // on the next boot instead of being forced to standalone.
                {
                    let _ = fs.lock().await.remove(cfg_path(b"standalone.txt\0"));
                }
                {
                    let mut c = CONTROL.lock().await;
                    c.file.set(arg);
                    c.mode = Mode::Play;
                    c.reload = true;
                }
                notify_state_change();
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
                    // Push the new name to every connected client. (The Wi-Fi discovery
                    // reply reads the live name too; the BLE advert name updates on next
                    // reboot.)
                    notify_state_change();
                    reply(sink, format_args!("OK NAME {}", trimmed)).await;
                }
            }
        }

        "BOOTSEL" => {
            // Reboot into the ROM USB bootloader (RPI-RP2) — the protocol.md
            // Maintenance command. The chip resets, so there is no reply.
            embassy_rp::rom_data::reset_to_usb_boot(0, 0);
        }

        "REBOOT" => {
            // Warm restart — re-runs boot, so it reloads config and re-advertises the
            // current name over BLE (the one thing a live rename can't refresh). Ack
            // first with a short beat so the client sees OK before the link drops, then
            // request a full system reset (SYSRESETREQ reboots the RP2040 from flash).
            sink.send("OK REBOOT").await;
            embassy_time::Timer::after(embassy_time::Duration::from_millis(250)).await;
            cortex_m::peripheral::SCB::sys_reset();
        }

        // --- Wi-Fi provisioning: stash SSID/pass, then WIFICONNECT writes
        // networks.txt + nudges the manager to join (no reboot). Absent in a
        // `wifi`-less build (the commands then fall through to ERR unknown). ---
        #[cfg(feature = "wifi")]
        "WIFISSID" => {
            crate::wifi::PENDING.lock().await.0.set(arg);
            sink.send("OK WIFISSID").await;
        }
        #[cfg(feature = "wifi")]
        "WIFIPASS" => {
            crate::wifi::PENDING.lock().await.1.set(arg);
            sink.send("OK WIFIPASS").await;
        }
        #[cfg(feature = "wifi")]
        "WIFICONNECT" => {
            let (ssid, pass) = {
                let p = crate::wifi::PENDING.lock().await;
                (heapless_of(p.0.as_str()), heapless_of(p.1.as_str()))
            };
            if ssid.is_empty() {
                sink.send("ERR no-ssid").await;
            } else {
                let mut buf: String<160> = String::new();
                let _ = write!(buf, "{}\n{}", ssid.as_str(), pass.as_str());
                write_cfg(fs, b"networks.txt\0", buf.as_bytes()).await;
                crate::wifi::CONNECT_SIG.signal(());
                sink.send("OK WIFICONNECT").await;
            }
        }
        #[cfg(feature = "wifi")]
        "WIFIFORGET" => {
            {
                let f = fs.lock().await;
                let _ = f.remove(cfg_path(b"networks.txt\0"));
            }
            crate::wifi::CONNECT_SIG.signal(());
            sink.send("OK WIFIFORGET").await;
        }
        #[cfg(feature = "wifi")]
        "WIFISTATUS" => {
            let s = crate::wifi::status_line().await;
            sink.send(&s).await;
        }

        // --- Read-only status queries. Sensible defaults until sync/power land, so
        // the app's Info pane gets clean answers instead of an ERR-unknown popup. ---
        "POWER" => sink.send("POWER unknown 0").await,
        "ROLE" => {
            let r = { role_name(CONTROL.lock().await.role) };
            reply(sink, format_args!("ROLE {}", r)).await;
        }
        "GROUP" => {
            let g = { CONTROL.lock().await.group };
            reply(sink, format_args!("GROUP {}", g)).await;
        }
        "DEVICE" => sink.send("DEVICE 0").await,
        "PROGRAM" => {
            // No-arg reports the program # from the selected file's `NN-` prefix.
            // (The setter — load the NN- slice + drive the group — lands with sync.)
            let prog = {
                let c = CONTROL.lock().await;
                program_of(c.file.as_str())
            };
            reply(sink, format_args!("PROGRAM {}", prog)).await;
        }
        "LOSS" => sink.send("LOSS indicate").await,
        "STARTUP" => sink.send("STARTUP go").await,
        "TEARDOWN" => sink.send("ERR not-leader").await,
        #[cfg(feature = "wifi")]
        "WIFISCAN" => {
            // Ask the Wi-Fi manager (which owns the radio Control) to scan, then
            // stream the results: WIFISCANLEN <n>, WIFINET <rssi> <ssid> …, WIFISCANEND.
            crate::wifi::SCAN_DONE.reset();
            crate::wifi::SCAN_REQ.signal(());
            match embassy_time::with_timeout(
                embassy_time::Duration::from_secs(12),
                crate::wifi::SCAN_DONE.wait(),
            )
            .await
            {
                Ok(()) => {
                    let results = crate::wifi::SCAN_RESULTS.lock().await;
                    reply(sink, format_args!("WIFISCANLEN {}", results.len())).await;
                    for e in results.iter() {
                        reply(sink, format_args!("WIFINET {} {}", e.rssi, e.ssid.as_str())).await;
                    }
                }
                Err(_) => sink.send("WIFISCANLEN 0").await,
            }
            sink.send("WIFISCANEND").await;
        }

        _ => sink.send("ERR unknown").await,
    }
}

/// Push the *complete* current picture to one client: the `INFO` state line plus the
/// identity/config the apps display (name, sync role/group, Wi-Fi status). Sent to every
/// connected client whenever anything changes ([`notify_state_change`]), so no app ever
/// shows stale info — a name edit, a Wi-Fi join, or a mode flip on one client refreshes
/// them all. Keeping it a full refresh (rather than "just the field that changed") means
/// a coalesced signal can never drop an update.
pub async fn send_snapshot(fs: &SharedFs, sink: &mut impl LineSink) {
    send_info(sink).await;
    {
        let c = CONTROL.lock().await;
        if !c.name.is_empty() {
            reply(sink, format_args!("NAME {}", c.name.as_str())).await;
        }
        reply(sink, format_args!("ROLE {}", role_name(c.role))).await;
        reply(sink, format_args!("GROUP {}", c.group)).await;
        let w = c.white;
        reply(sink, format_args!("WHITEBAL {} {} {}", w[0], w[1], w[2])).await;
    }
    let bit = |m: u8| if crate::state::render_flags() & m != 0 { 1 } else { 0 };
    reply(
        sink,
        format_args!(
            "RENDER {} {} {}",
            bit(crate::state::FX_GAMMA),
            bit(crate::state::FX_WHITE),
            bit(crate::state::FX_DITHER)
        ),
    )
    .await;
    let _ = fs; // reserved (auth/free are static enough not to push)
    // Wi-Fi status line — omitted in a `wifi`-less build (the app shows N/A for the
    // keys it doesn't receive).
    #[cfg(feature = "wifi")]
    {
        let s = crate::wifi::status_line().await;
        sink.send(&s).await;
    }
}

/// Build + send the one-line `INFO` state snapshot. Used both by the `INFO` command and
/// as the first line of [`send_snapshot`].
pub async fn send_info(sink: &mut impl LineSink) {
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

/// Verify a `LOGIN <hash>` against the current challenge, with a rate limit.
async fn do_login(arg: &str, pin: &str, conn: &mut ConnState, sink: &mut impl LineSink) {
    let now = Instant::now().as_millis() as u32;
    let fail_at = AUTH_FAIL_AT.load(Ordering::Relaxed);
    if fail_at != 0 && now.wrapping_sub(fail_at) < AUTH_RETRY_MS {
        sink.send("ERR auth-wait").await;
        return;
    }
    if conn.nonce.is_empty() || arg.is_empty() {
        sink.send("ERR auth").await; // must fetch a challenge (INFO) first
        return;
    }
    let expected = expected_hash(pin, conn.nonce.as_str());
    if arg.eq_ignore_ascii_case(expected.as_str()) {
        conn.authed = true;
        sink.send("OK LOGIN").await;
    } else {
        AUTH_FAIL_AT.store(now.max(1), Ordering::Relaxed);
        sink.send("ERR auth").await;
    }
}

/// The protocol token for a sync role.
fn role_name(role: crate::state::Role) -> &'static str {
    use crate::state::Role;
    match role {
        Role::Standalone => "standalone",
        Role::Leader => "leader",
        Role::LeaderOnly => "leader-only",
        Role::Follower => "follower",
        Role::Auto => "auto",
    }
}

/// A pattern's program number = its zero-padded `NN-` filename prefix (else 0).
fn program_of(name: &str) -> u8 {
    let b = name.as_bytes();
    if b.len() >= 3 && b[2] == b'-' && b[0].is_ascii_digit() && b[1].is_ascii_digit() {
        (b[0] - b'0') * 10 + (b[1] - b'0')
    } else {
        0
    }
}

/// Format + send a single reply line.
async fn reply(sink: &mut impl LineSink, args: core::fmt::Arguments<'_>) {
    let mut r = Reply::new();
    let _ = r.write_fmt(args);
    sink.send(&r).await;
}
