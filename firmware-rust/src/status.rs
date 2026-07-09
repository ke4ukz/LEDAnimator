//! LED 0 status indicator — port of the MicroPython `_STATUS` / `_show_status`
//! (see `docs/led0-status.md`). LED 0 shows a status color (while the rest of the
//! strip is dark) at a fixed visibility that's independent of master brightness,
//! so it stays readable at brightness 0. Three envelopes: solid / pulse / blink.

use crate::ws2812::grb_word;
use embassy_time::Instant;

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
    let ph = (Instant::now().as_millis() % 1000) as u32;
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
