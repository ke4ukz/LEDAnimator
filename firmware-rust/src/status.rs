//! LED 0 status + boot diagnostics — the Rust port of the MicroPython status
//! layer. Full spec (colors, codes, philosophy): **`docs/led0-status.md`**.
//!
//! LED 0 (only — never the whole strip) carries three things:
//!   * **Ambient status** — ongoing benign runtime states (`Status`), one hue.
//!   * **Boot-stage indicator** (`BootStage`) — a dim color per init step, so a
//!     hang freezes on the stalled stage's color.
//!   * **Boot error code** (`BootError`) — a subsystem beat then a severity color
//!     blinked a small count. Errors are boot-only; severity encodes recovery
//!     (red = fatal/RMA, yellow = non-fatal/Wi-Fi).
//!
//! Status brightness is independent of master brightness (readable at `BRIGHT 0`).
//! Colors carry no protocol meaning — tune freely, but keep both firmwares and
//! `docs/led0-status.md` in step.

use crate::ws2812::grb_word;
use embassy_time::Instant;

#[inline]
fn now_ms() -> u64 {
    Instant::now().as_millis()
}

// ======================= Ambient operational states =======================

#[derive(Clone, Copy)]
enum Env {
    #[allow(dead_code)]
    Solid,
    Pulse,
    Blink,
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Acquiring/Searching/Noprogram are used once sync lands
pub enum Status {
    /// Follower up, awaiting first beacon (blue pulse).
    Acquiring,
    /// Follower free-running, leader lost (amber blink, usually an overlay).
    Searching,
    /// Nothing selected/playable (red pulse).
    Nofile,
    /// Follower lacks a slice for the group's program (red blink).
    Noprogram,
}

impl Status {
    fn spec(self) -> ((u8, u8, u8), Env) {
        match self {
            Status::Acquiring => ((0, 40, 255), Env::Pulse),
            Status::Searching => ((255, 90, 0), Env::Blink),
            Status::Nofile => ((255, 0, 0), Env::Pulse),
            Status::Noprogram => ((255, 0, 0), Env::Blink),
        }
    }
}

/// ~1 Hz brightness envelope, 0..=256 (matches `_status_env`).
fn envelope(e: Env) -> u32 {
    let ph = (now_ms() % 1000) as u32;
    match e {
        Env::Solid => 256,
        Env::Blink => {
            if ph < 500 {
                256
            } else {
                0
            }
        }
        Env::Pulse => {
            let t = if ph < 500 { ph } else { 1000 - ph };
            t * 256 / 500
        }
    }
}

/// The GRB word to drive LED 0 for `status` right now (the rest of the strip
/// should be 0). Call this each refresh so the envelope animates.
pub fn led0_word(status: Status) -> u32 {
    let ((r, g, b), env) = status.spec();
    let e = envelope(env);
    let scale = |c: u8| ((c as u32 * e) >> 8) as u8;
    grb_word(scale(r), scale(g), scale(b))
}

// ============================ Boot-stage indicator ============================

/// A blocking init step. LED 0 holds this stage's **dim solid** color while the
/// step runs; if boot hangs, the frozen color names the culprit. Palette matches
/// the fault `Subsystem`s so the mnemonic carries over.
#[derive(Clone, Copy)]
#[allow(dead_code)] // Storage/Radio/Network wired as those subsystems land
pub enum BootStage {
    /// Filesystem / config mount (dim magenta).
    Storage,
    /// Radio (CYW43) bring-up (dim blue).
    Radio,
    /// Network bring-up, only if Wi-Fi provisioned (dim cyan).
    Network,
    /// Boot finished — brief green flash before the run loop.
    Complete,
}

impl BootStage {
    fn color(self) -> (u8, u8, u8) {
        match self {
            BootStage::Storage => (40, 0, 40),  // dim magenta
            BootStage::Radio => (0, 0, 40),     // dim blue
            BootStage::Network => (0, 40, 40),  // dim cyan
            BootStage::Complete => (0, 120, 0), // green
        }
    }

    /// Dim solid LED-0 word for this stage.
    pub fn led0_word(self) -> u32 {
        let (r, g, b) = self.color();
        grb_word(r, g, b)
    }
}

// ============================== Boot error code ==============================

/// Which subsystem failed (field 1 of the code — the solid leading beat).
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum Subsystem {
    /// cyan
    Wifi,
    /// blue
    Radio,
    /// magenta
    System,
}

#[allow(dead_code)]
impl Subsystem {
    fn color(self) -> (u8, u8, u8) {
        match self {
            Subsystem::Wifi => (0, 180, 180),    // cyan
            Subsystem::Radio => (0, 0, 255),     // blue
            Subsystem::System => (180, 0, 180),  // magenta
        }
    }
}

/// How bad (field 2 — the blinked color). Encodes recoverability:
/// `Fatal` (red) = device won't run, RMA; `Warn` (yellow) = device runs on.
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum Severity {
    /// red
    Fatal,
    /// yellow
    Warn,
}

#[allow(dead_code)]
impl Severity {
    fn color(self) -> (u8, u8, u8) {
        match self {
            Severity::Fatal => (255, 0, 0),  // red
            Severity::Warn => (255, 170, 0), // yellow
        }
    }
}

// Sentence timing (ms) — keep in step with docs/led0-status.md.
#[allow(dead_code)]
const ERR_SUBSYS_MS: u64 = 700;
#[allow(dead_code)]
const ERR_GAP_MS: u64 = 300;
#[allow(dead_code)]
const ERR_BLINK_ON: u64 = 250;
#[allow(dead_code)]
const ERR_BLINK_OFF: u64 = 250;
#[allow(dead_code)]
const ERR_TAIL_MS: u64 = 1200;

/// A boot error code: `subsystem` (who) + `severity` (how bad) blinked `code`
/// times (which). `code` is 1..=4 — see the table in docs/led0-status.md.
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub struct BootError {
    pub subsystem: Subsystem,
    pub severity: Severity,
    pub code: u8,
}

#[allow(dead_code)]
impl BootError {
    pub const fn new(subsystem: Subsystem, severity: Severity, code: u8) -> Self {
        Self { subsystem, severity, code }
    }

    fn cycle_ms(&self) -> u64 {
        ERR_SUBSYS_MS + ERR_GAP_MS + self.code as u64 * (ERR_BLINK_ON + ERR_BLINK_OFF) + ERR_TAIL_MS
    }

    /// LED-0 word for this code right now (rest of strip should be 0). Renders the
    /// repeating "subsystem beat → gap → N severity blinks → tail" sentence off
    /// the wall clock, so a shelf of identical failures blinks in rough unison.
    pub fn led0_word(&self) -> u32 {
        let mut t = now_ms() % self.cycle_ms();

        // Phase 1: subsystem color, solid.
        if t < ERR_SUBSYS_MS {
            let (r, g, b) = self.subsystem.color();
            return grb_word(r, g, b);
        }
        t -= ERR_SUBSYS_MS;

        // Phase 2: gap.
        if t < ERR_GAP_MS {
            return 0;
        }
        t -= ERR_GAP_MS;

        // Phase 3: N severity blinks.
        let period = ERR_BLINK_ON + ERR_BLINK_OFF;
        let span = self.code as u64 * period;
        if t < span {
            if t % period < ERR_BLINK_ON {
                let (r, g, b) = self.severity.color();
                return grb_word(r, g, b);
            }
            return 0;
        }

        // Phase 4: tail (dark).
        0
    }
}

/// The documented codes (docs/led0-status.md → error table). Fatal (red) halt;
/// Wi-Fi (yellow) codes are shown at boot then the device runs on.
#[allow(dead_code)]
pub mod errors {
    use super::BootError;
    use super::Severity::*;
    use super::Subsystem::*;

    // Fatal — device won't run (RMA).
    pub const RADIO_NOT_RESPONDING: BootError = BootError::new(Radio, Fatal, 1);
    pub const RADIO_FW_LOAD_FAILED: BootError = BootError::new(Radio, Fatal, 2);
    pub const BT_INIT_FAILED: BootError = BootError::new(Radio, Fatal, 3);
    pub const FS_MOUNT_FAILED: BootError = BootError::new(System, Fatal, 1);
    pub const CONFIG_CORRUPT: BootError = BootError::new(System, Fatal, 2);
    pub const INTERNAL_ERROR: BootError = BootError::new(System, Fatal, 3);

    // Non-fatal — Wi-Fi only; device runs on.
    pub const WIFI_AUTH_FAILED: BootError = BootError::new(Wifi, Warn, 1);
    pub const WIFI_NOT_FOUND: BootError = BootError::new(Wifi, Warn, 2);
    pub const WIFI_NO_IP: BootError = BootError::new(Wifi, Warn, 3);
}

// ============================= Recovery flashes =============================

/// Whole-strip vs LED-0-only for the power-cycle recovery ritual flashes — the one
/// intentional whole-strip exception (a deliberate, user-watched ritual). Flip to
/// `false` to keep even these to LED 0. See docs/led0-status.md.
pub const RECOVERY_WHOLE_STRIP: bool = true;

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum Recovery {
    /// 5th interrupted boot — PIN cleared (cyan).
    PinCleared,
    /// 10th interrupted boot — full reset (magenta).
    FactoryReset,
}

impl Recovery {
    fn color(self) -> (u8, u8, u8) {
        match self {
            Recovery::PinCleared => (0, 180, 180),   // cyan
            Recovery::FactoryReset => (200, 0, 200), // magenta
        }
    }
}

/// Paint a recovery flash into `buf` (caller shows it for ~1.5 s). Honors
/// `RECOVERY_WHOLE_STRIP`: whole strip, or LED 0 only.
#[allow(dead_code)]
pub fn paint_recovery(kind: Recovery, buf: &mut [u32]) {
    let (r, g, b) = kind.color();
    let w = grb_word(r, g, b);
    for x in buf.iter_mut() {
        *x = 0;
    }
    if RECOVERY_WHOLE_STRIP {
        for x in buf.iter_mut() {
            *x = w;
        }
    } else if let Some(first) = buf.first_mut() {
        *first = w;
    }
}
