//! Shared control state — written by the control channels (BLE/Wi-Fi command
//! dispatch), read by the player loop each frame. Guarded by an async `Mutex` so a
//! command and a frame render never tear.
//!
//! The Rust equivalent of the MicroPython `S.mode`/`S.bright`/`S.speed`/`S.solid`/
//! `S.file`/`S.name`/`S.reload` runtime state (see `web/src/export/rp2040.ts`).

use core::fmt::Write as _;
use core::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_sync::watch::{Receiver, Watch};

/// Render-stage feature flags, read per pixel by `leda::grb_pixel` + the player's
/// dither loop. Toggleable live (the `RENDER` command) so the perceptual steps can
/// be A/B'd on the same pattern; persisted in `render.txt`. Default gamma + white
/// on, dither OFF (opt-in: dither engages a high-refresh sub-loop).
pub const FX_GAMMA: u8 = 0b001;
pub const FX_WHITE: u8 = 0b010;
pub const FX_DITHER: u8 = 0b100;
static RENDER_FLAGS: AtomicU8 = AtomicU8::new(FX_GAMMA | FX_WHITE);

pub fn set_render_flags(f: u8) {
    RENDER_FLAGS.store(f & 0b111, Ordering::Relaxed);
}
pub fn render_flags() -> u8 {
    RENDER_FLAGS.load(Ordering::Relaxed)
}
pub fn dither_on() -> bool {
    render_flags() & FX_DITHER != 0
}

/// The 3-byte device id (last 3 bytes of the Wi-Fi MAC), packed in the low 24 bits.
/// It ties the BLE advert (manufacturer data) to the Wi-Fi hostname suffix so the
/// app recognizes one physical device across both transports. Set once at boot.
static DEVICE_ID: AtomicU32 = AtomicU32::new(0);

/// Full Wi-Fi MAC (packed: bytes 0..4 in LOW, bytes 4..6 in HIGH) for `MOREINFO`.
static MAC_LOW: AtomicU32 = AtomicU32::new(0);
static MAC_HIGH: AtomicU32 = AtomicU32::new(0);

/// Seed the device id + full MAC from the 6-byte Wi-Fi MAC (id = the last 3 bytes).
pub fn set_device_id(mac: &[u8; 6]) {
    let id = ((mac[3] as u32) << 16) | ((mac[4] as u32) << 8) | (mac[5] as u32);
    DEVICE_ID.store(id, Ordering::Relaxed);
    MAC_LOW.store(u32::from_le_bytes([mac[0], mac[1], mac[2], mac[3]]), Ordering::Relaxed);
    MAC_HIGH.store(u32::from_le_bytes([mac[4], mac[5], 0, 0]), Ordering::Relaxed);
}

/// The full Wi-Fi MAC as 6 bytes.
pub fn mac_bytes() -> [u8; 6] {
    let l = MAC_LOW.load(Ordering::Relaxed);
    let h = MAC_HIGH.load(Ordering::Relaxed);
    [
        l as u8,
        (l >> 8) as u8,
        (l >> 16) as u8,
        (l >> 24) as u8,
        h as u8,
        (h >> 8) as u8,
    ]
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

// --- Playback position for the sync beacon: the last shown frame + the clock (ms)
// when it was shown. Written by the player each frame, read by the leader beacon.
// Lightweight atomics (load/store only) to avoid contending CONTROL every frame. ---
static POS_FRAME: AtomicU32 = AtomicU32::new(0);
static POS_TS_MS: AtomicU32 = AtomicU32::new(0);

/// Record that `frame` was shown at `ts_ms` (embassy `Instant` millis).
pub fn set_position(frame: u32, ts_ms: u32) {
    POS_FRAME.store(frame, Ordering::Relaxed);
    POS_TS_MS.store(ts_ms, Ordering::Relaxed);
}

/// The last shown `(frame, ts_ms)`.
pub fn position() -> (u32, u32) {
    (POS_FRAME.load(Ordering::Relaxed), POS_TS_MS.load(Ordering::Relaxed))
}

/// The frame a **follower** should currently display (from its phase-lock loop), or
/// `NO_LOCK` while acquiring/searching. Published by the follower, read by the player.
pub const NO_LOCK: u32 = u32::MAX;
static FOLLOWER_FRAME: AtomicU32 = AtomicU32::new(NO_LOCK);

pub fn set_follower_frame(f: u32) {
    FOLLOWER_FRAME.store(f, Ordering::Relaxed);
}
pub fn follower_frame() -> u32 {
    FOLLOWER_FRAME.load(Ordering::Relaxed)
}

/// Sync role (the `.leda` header byte): does this device lead, follow, or neither?
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Standalone,
    Leader,
    LeaderOnly,
    Follower,
    Auto,
}

impl Role {
    pub fn from_header(b: u8) -> Self {
        match b {
            1 => Role::Leader,
            2 => Role::LeaderOnly,
            3 => Role::Follower,
            4 => Role::Auto,
            _ => Role::Standalone,
        }
    }
    /// Does this role broadcast the sync beacon?
    pub fn is_leader(self) -> bool {
        matches!(self, Role::Leader | Role::LeaderOnly)
    }
    /// Does this role scan + phase-lock to a leader's beacon?
    pub fn is_follower(self) -> bool {
        matches!(self, Role::Follower)
    }
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
    /// Sync role from the active `.leda` header.
    pub role: Role,
    /// Sync group id (header) — followers bind to a leader's group.
    pub group: u8,
    /// Program number (the selected file's `NN-` prefix) — carried in the beacon.
    pub program: u8,
    /// White-balance per-channel gains 0..=255 (the "canonical white" calibration).
    /// Applied at render as `channel * gain / 255`, so `[255,255,255]` is neutral.
    /// Corrects the WS2812's non-neutral white; persisted in `whitebal.txt`.
    pub white: [u8; 3],
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
            role: Role::Standalone,
            group: 0,
            program: 0,
            white: [255, 255, 255],
        }
    }
}

/// The one shared control state. Seeded from config at boot (see `main`).
pub static CONTROL: Mutex<CriticalSectionRawMutex, Control> = Mutex::new(Control::new());

/// Bumped whenever an observable control value (mode/bright/speed/solid/file) changes,
/// so every connected client can be pushed a fresh `INFO` and the apps stay in sync
/// even when a *different* app made the change. The MicroPython firmware broadcast the
/// state line to all transports the same way. The BLE advert also watches it to restart
/// with the live name on a rename. Sized for the watchers: 3 TCP control clients + the
/// BLE control link + the BLE advert loop, with margin.
pub static STATE_WATCH: Watch<CriticalSectionRawMutex, u32, 8> = Watch::new();

/// Number type carried by [`STATE_WATCH`]; the value is a rolling change counter (its
/// content is irrelevant — any send wakes the receivers).
pub type StateWatchRx = Receiver<'static, CriticalSectionRawMutex, u32, 8>;

/// Signal that observable state changed. Call after a successful setter (`BRIGHT`,
/// `SPEED`, `SOLID`, `OFF`, `PLAY`, `SELECT`, `PROGRAM`) so watchers push a fresh INFO.
pub fn notify_state_change() {
    STATE_WATCH.sender().send_modify(|v| {
        *v = Some(v.map_or(0, |x| x.wrapping_add(1)));
    });
}

/// A receiver a connection task awaits to learn state changed elsewhere. `None` once all
/// watcher slots are taken (that connection then just won't get live pushes — no harm).
pub fn state_watch_receiver() -> Option<StateWatchRx> {
    STATE_WATCH.receiver()
}

/// The current device name for adverts/GAP — the configured name, or a default until one
/// is set. Copied out so the caller doesn't hold the `CONTROL` lock.
pub async fn display_name() -> FixedStr<32> {
    let c = CONTROL.lock().await;
    let mut s = FixedStr::new();
    s.set(if c.name.is_empty() { "LED Animator" } else { c.name.as_str() });
    s
}

/// A snapshot the player reads without holding the lock across a render.
#[derive(Clone, Copy)]
pub struct Snapshot {
    pub bright: u8,
    pub speed: u16,
    pub mode: Mode,
    pub solid: [u8; 3],
    pub reload: bool,
    pub role: Role,
    pub white: [u8; 3],
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
        role: c.role,
        white: c.white,
    };
    c.reload = false;
    snap
}
