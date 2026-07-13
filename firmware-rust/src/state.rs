//! Shared control state — written by the control channels (BLE/Wi-Fi command
//! dispatch), read by the player loop each frame. Small and cheap to copy; guarded
//! by an async `Mutex` so a command and a frame render never tear.
//!
//! This is the Rust equivalent of the MicroPython `S.mode` / `S.bright` / `S.speed`
//! / `S.reload` runtime state (see `web/src/export/rp2040.ts`).

use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;

/// What the strip is currently showing.
#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Solid/Off constructed once the control setters (BLE/Wi-Fi) land
pub enum Mode {
    /// Play the selected `.leda` pattern.
    Play,
    /// Hold a solid color (`SOLID r g b`).
    Solid([u8; 3]),
    /// Blank (`OFF`).
    Off,
}

/// Live control state. Setter commands mutate this; the player reads a snapshot
/// each frame and renders accordingly.
pub struct Control {
    /// Master brightness 0..=255 (the `BRIGHT 0-100` percent, pre-scaled).
    pub bright: u8,
    /// Playback speed 10..=400, percent of the authored rate (100 = as authored).
    pub speed: u16,
    /// What to show.
    pub mode: Mode,
    /// A `SELECT`/`PROGRAM` changed `selected.txt`; the player reloads the pattern
    /// from flash on its next iteration and clears this.
    pub reload: bool,
}

impl Control {
    pub const fn new() -> Self {
        Self {
            bright: 255,
            speed: 100,
            mode: Mode::Play,
            reload: false,
        }
    }
}

/// The one shared control state. Initialized from config at boot (see `main`).
pub static CONTROL: Mutex<CriticalSectionRawMutex, Control> = Mutex::new(Control::new());

/// A frame-rate-independent snapshot the player reads without holding the lock
/// across a render.
#[derive(Clone, Copy)]
pub struct Snapshot {
    pub bright: u8,
    pub speed: u16,
    pub mode: Mode,
    pub reload: bool,
}

/// Copy out the current state (and clear `reload`, since the caller will act on it).
pub async fn take_snapshot() -> Snapshot {
    let mut c = CONTROL.lock().await;
    let snap = Snapshot {
        bright: c.bright,
        speed: c.speed,
        mode: c.mode,
        reload: c.reload,
    };
    c.reload = false;
    snap
}
