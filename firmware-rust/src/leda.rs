//! LEDA v1 pattern format (see `docs/file-format.md`, `web/src/export/format.ts`).
//!
//! ```text
//!   0   4  magic 'LEDA'
//!   4   1  version (1)
//!   5   1  pixel format (0 = RGB888)
//!   6   2  numLeds   (u16 LE)
//!   8   4  numFrames (u32 LE)
//!   12  2  fps       (u16 LE)
//!   14  1  role   (0 standalone / 1 leader / 2 leader-only / 3 follower / 4 auto)
//!   15  1  group
//!   16  1  device
//!   17  1  syncflags: (lossPolicy & 0x3) | ((startup & 1) << 2)
//!   18  2  reserved
//!   20 ... raster: for each frame, numLeds × (R,G,B)   [frame-major]
//! ```
//! A leader-only file is a header with `role == 2` and no raster.

use crate::ws2812::grb_word;

pub const HEADER_SIZE: usize = 20;
const MAGIC: &[u8] = b"LEDA";

#[derive(Clone, Copy)]
#[allow(dead_code)] // role/group/device/sync are read now, wired when sync lands
pub struct Header {
    pub num_leds: u16,
    pub num_frames: u32,
    pub fps: u16,
    pub role: u8,
    pub group: u8,
    pub device: u8,
    pub loss_policy: u8, // 0 indicate / 1 silent / 2 blackout
    pub startup_go: bool,
}

/// A parsed pattern borrowing the file bytes (header + raster).
pub struct Pattern<'a> {
    pub header: Header,
    data: &'a [u8],
}

impl<'a> Pattern<'a> {
    /// Validate the magic + size and read the header. `None` for a non-LEDA blob.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER_SIZE || &bytes[0..4] != MAGIC {
            return None;
        }
        let sync = bytes[17];
        let header = Header {
            num_leds: u16::from_le_bytes([bytes[6], bytes[7]]),
            num_frames: u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            fps: u16::from_le_bytes([bytes[12], bytes[13]]),
            role: bytes[14],
            group: bytes[15],
            device: bytes[16],
            loss_policy: sync & 0x03,
            startup_go: (sync >> 2) & 1 != 0,
        };
        Some(Pattern { header, data: bytes })
    }

    /// The `numLeds × 3` RGB bytes for frame `i`, or `None` if past the end.
    pub fn frame(&self, i: u32) -> Option<&'a [u8]> {
        let fb = self.header.num_leds as usize * 3;
        let start = HEADER_SIZE + (i as usize) * fb;
        self.data.get(start..start + fb)
    }
}

/// Convert a frame's RGB bytes into GRB<<8 words (the `_fill_grb` port), scaling
/// by master brightness `bright` (0..=255). Writes `out[0..num_leds]`.
pub fn fill_grb(frame_rgb: &[u8], out: &mut [u32], bright: u8) {
    for (i, px) in frame_rgb.chunks_exact(3).enumerate() {
        if i >= out.len() {
            break;
        }
        // scale each channel by bright/255 (matches the MicroPython brightness path)
        let r = ((px[0] as u16 * bright as u16) / 255) as u8;
        let g = ((px[1] as u16 * bright as u16) / 255) as u8;
        let b = ((px[2] as u16 * bright as u16) / 255) as u8;
        out[i] = grb_word(r, g, b);
    }
}
