//! Shared control state — written by the control channels (BLE/Wi-Fi command
//! dispatch), read by the player loop each frame. Guarded by an async `Mutex` so a
//! command and a frame render never tear.
//!
//! The Rust equivalent of the MicroPython `S.mode`/`S.bright`/`S.speed`/`S.solid`/
//! `S.file`/`S.name`/`S.reload` runtime state (see `web/src/export/rp2040.ts`).

use core::fmt::Write as _;
use core::sync::atomic::{AtomicU32, Ordering};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;

/// The 3-byte device id (last 3 bytes of the Wi-Fi MAC), packed in the low 24 bits.
/// It ties the BLE advert (manufacturer data) to the Wi-Fi hostname suffix so the
/// app recognizes one physical device across both transports. Set once at boot.
static DEVICE_ID: AtomicU32 = AtomicU32::new(0);

/// Seed the device id from the 6-byte MAC (uses the last 3 bytes).
pub fn set_device_id(mac: &[u8; 6]) {
    let id = ((mac[3] as u32) << 16) | ((mac[4] as u32) << 8) | (mac[5] as u32);
    DEVICE_ID.store(id, Ordering::Relaxed);
}

/// The device id as 3 raw bytes (for the BLE manufacturer data payload).
pub fn device_id_bytes() -> [u8; 3] {
    let v = DEVICE_ID.load(Ordering::Relaxed);
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

/// The device id as 6 uppercase hex chars (for the Wi-Fi hostname suffix).
pub fn device_id_hex() -> FixedStr<8> {
    let [a, b, c] = device_id_bytes();
    let mut s: heapless::String<8> = heapless::String::new();
    let _ = write!(s, "{:02X}{:02X}{:02X}", a, b, c);
    let mut out = FixedStr::new();
    out.set(s.as_str());
    out
}

/// A tiny fixed-capacity UTF-8 string (const-constructible, no alloc) for the
/// device name + selected filename living in the shared state.
#[derive(Clone, Copy)]
pub struct FixedStr<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> FixedStr<N> {
    pub const fn new() -> Self {
        Self { buf: [0; N], len: 0 }
    }
    /// Overwrite with `s` (truncated to capacity, at a UTF-8 boundary).
    pub fn set(&mut self, s: &str) {
        let mut n = s.as_bytes().len().min(N);
        while n > 0 && !s.is_char_boundary(n) {
            n -= 1;
        }
        self.buf[..n].copy_from_slice(&s.as_bytes()[..n]);
        self.len = n;
    }
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("")
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// What the strip is currently showing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Play the selected `.leda` pattern.
    Play,
    /// Hold `Control::solid`.
    Solid,
    /// Blank.
    Off,
}

impl Mode {
    /// The protocol token used in the `INFO` line.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Play => "play",
            Mode::Solid => "solid",
            Mode::Off => "off",
        }
    }
}

/// Live control state. Setter commands mutate this; the player reads a snapshot
/// each frame and renders accordingly.
pub struct Control {
    /// Master brightness as a percent 0..=100 (matches `bright.txt` + the `BRIGHT`
    /// command + `INFO`, so values round-trip exactly). Scaled to 0..=255 at render.
    pub bright: u8,
    /// Playback speed 10..=400, percent of the authored rate (100 = as authored).
    pub speed: u16,
    /// What to show.
    pub mode: Mode,
    /// The last solid color (kept even outside `Solid`, so `INFO` reports it).
    pub solid: [u8; 3],
    /// A `SELECT`/`PROGRAM`/`PLAY` asks the player to reload the pattern from flash.
    pub reload: bool,
    /// The selected pattern's filename (for `INFO`).
    pub file: FixedStr<64>,
    /// The user-visible device name (for `INFO`/`NAME` and the BLE advert).
    pub name: FixedStr<32>,
}

impl Control {
    pub const fn new() -> Self {
        Self {
            bright: 100,
            speed: 100,
            mode: Mode::Play,
            solid: [0, 0, 0],
            reload: false,
            file: FixedStr::new(),
            name: FixedStr::new(),
        }
    }
}

/// The one shared control state. Seeded from config at boot (see `main`).
pub static CONTROL: Mutex<CriticalSectionRawMutex, Control> = Mutex::new(Control::new());

/// A snapshot the player reads without holding the lock across a render.
#[derive(Clone, Copy)]
pub struct Snapshot {
    pub bright: u8,
    pub speed: u16,
    pub mode: Mode,
    pub solid: [u8; 3],
    pub reload: bool,
}

/// Copy out the current state (clearing `reload`, since the caller acts on it).
pub async fn take_snapshot() -> Snapshot {
    let mut c = CONTROL.lock().await;
    let snap = Snapshot {
        bright: c.bright,
        speed: c.speed,
        mode: c.mode,
        solid: c.solid,
        reload: c.reload,
    };
    c.reload = false;
    snap
}
