//! LEDA v1 pattern format (see `docs/file-format.md`, `web/src/export/format.ts`).
//!
//! ```text
//!   0   4  magic 'LEDA'
//!   4   1  version (1)
//!   5   1  pixel format (0 = RGB888, 1 = RGB565, 2 = indexed)
//!   6   2  numLeds   (u16 LE)
//!   8   4  numFrames (u32 LE)
//!   12  2  fps       (u16 LE)
//!   14  1  role   (0 standalone / 1 leader / 2 leader-only / 3 follower / 4 auto)
//!   15  1  group
//!   16  1  device
//!   17  1  syncflags: (lossPolicy & 0x3) | ((startup & 1) << 2)
//!   18  2  reserved
//!   20 ... [indexed only] palette block: u16 count + count × (R,G,B)
//!    then  raster: for each frame, numLeds × pixel  [frame-major]
//! ```
//! Pixel size by format: RGB888 = 3 B (R,G,B), RGB565 = 2 B (u16 LE 5-6-5),
//! indexed = 1 B (palette index). A leader-only file is a header with `role == 2`
//! and no raster.

use crate::ws2812::grb_word;

pub const HEADER_SIZE: usize = 20;
const MAGIC: &[u8] = b"LEDA";

pub const FMT_RGB888: u8 = 0;
pub const FMT_RGB565: u8 = 1;
pub const FMT_INDEXED: u8 = 2;

#[derive(Clone, Copy)]
#[allow(dead_code)] // role/group/device/sync are read now, wired when sync lands
pub struct Header {
    pub format: u8,
    pub num_leds: u16,
    pub num_frames: u32,
    pub fps: u16,
    pub role: u8,
    pub group: u8,
    pub device: u8,
    pub loss_policy: u8, // 0 indicate / 1 silent / 2 blackout
    pub startup_go: bool,
}

/// A parsed pattern borrowing the file bytes (header + optional palette + raster).
pub struct Pattern<'a> {
    pub header: Header,
    data: &'a [u8],
    bpp: usize,          // bytes per LED in the raster (3 / 2 / 1)
    pixel_start: usize,  // offset where frame data begins (past any palette)
    palette: &'a [u8],   // indexed palette (count × 3 RGB), empty otherwise
}

impl<'a> Pattern<'a> {
    /// Validate the magic + size and read the header. `None` for a non-LEDA blob
    /// or a pixel format this firmware doesn't understand.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER_SIZE || &bytes[0..4] != MAGIC {
            return None;
        }
        let format = bytes[5];
        let bpp = match format {
            FMT_RGB565 => 2,
            FMT_INDEXED => 1,
            FMT_RGB888 => 3,
            _ => return None, // refuse formats we can't decode
        };
        // Indexed files carry a palette block (u16 count + count×3) right after the
        // header; the frame data starts past it.
        let (pixel_start, palette) = if format == FMT_INDEXED {
            let count = u16::from_le_bytes([*bytes.get(HEADER_SIZE)?, *bytes.get(HEADER_SIZE + 1)?]) as usize;
            let pal_off = HEADER_SIZE + 2;
            let pal_end = pal_off + count * 3;
            (pal_end, bytes.get(pal_off..pal_end)?)
        } else {
            (HEADER_SIZE, &bytes[0..0])
        };
        let sync = bytes[17];
        let header = Header {
            format,
            num_leds: u16::from_le_bytes([bytes[6], bytes[7]]),
            num_frames: u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            fps: u16::from_le_bytes([bytes[12], bytes[13]]),
            role: bytes[14],
            group: bytes[15],
            device: bytes[16],
            loss_policy: sync & 0x03,
            startup_go: (sync >> 2) & 1 != 0,
        };
        Some(Pattern { header, data: bytes, bpp, pixel_start, palette })
    }

    /// The `numLeds × bpp` raw pixel bytes for frame `i`, or `None` if past the end.
    pub fn frame(&self, i: u32) -> Option<&'a [u8]> {
        let fb = self.header.num_leds as usize * self.bpp;
        let start = self.pixel_start + (i as usize) * fb;
        self.data.get(start..start + fb)
    }

    /// Decode frame `i` into GRB<<8 words, applying master brightness `bright`
    /// (0..=255) + the white-balance gains `white`. Returns `false` (leaving `out`
    /// untouched) if the frame is missing.
    pub fn render(&self, i: u32, out: &mut [u32], bright: u8, white: [u8; 3]) -> bool {
        let Some(px) = self.frame(i) else { return false };
        match self.header.format {
            FMT_RGB565 => fill_565(px, out, bright, white),
            FMT_INDEXED => fill_indexed(px, self.palette, out, bright, white),
            _ => fill_888(px, out, bright, white),
        }
        true
    }
}

/// The single place a color becomes a driven GRB word: per-channel white-balance
/// gain + master brightness (both linear `channel * gain / 255`). Gamma / dithering
/// will land here too. Every render path — all three pixel formats *and* the solid
/// fill — funnels through this, so calibration applies uniformly.
pub fn grb_pixel(r: u8, g: u8, b: u8, bright: u8, white: [u8; 3]) -> u32 {
    let ch = |c: u8, w: u8| ((c as u32 * bright as u32 * w as u32) / (255 * 255)) as u8;
    grb_word(ch(r, white[0]), ch(g, white[1]), ch(b, white[2]))
}

/// RGB888 (3 B/LED) → GRB<<8 words. Writes `out[0..num_leds]`.
fn fill_888(frame_rgb: &[u8], out: &mut [u32], bright: u8, white: [u8; 3]) {
    for (i, px) in frame_rgb.chunks_exact(3).enumerate() {
        if i >= out.len() {
            break;
        }
        out[i] = grb_pixel(px[0], px[1], px[2], bright, white);
    }
}

/// RGB565 (2 B/LED, u16 LE) → GRB<<8 words, expanding 5/6/5 back to 8 bits.
fn fill_565(frame: &[u8], out: &mut [u32], bright: u8, white: [u8; 3]) {
    for (i, px) in frame.chunks_exact(2).enumerate() {
        if i >= out.len() {
            break;
        }
        let v = u16::from_le_bytes([px[0], px[1]]);
        let r5 = (v >> 11) & 0x1f;
        let g6 = (v >> 5) & 0x3f;
        let b5 = v & 0x1f;
        // Bit-replicate the low bits so full white stays 255, not 248/252.
        let r = ((r5 << 3) | (r5 >> 2)) as u8;
        let g = ((g6 << 2) | (g6 >> 4)) as u8;
        let b = ((b5 << 3) | (b5 >> 2)) as u8;
        out[i] = grb_pixel(r, g, b, bright, white);
    }
}

/// Indexed (1 B/LED) → GRB<<8 words via the palette (RGB triples). Out-of-range
/// indices render black.
fn fill_indexed(frame: &[u8], palette: &[u8], out: &mut [u32], bright: u8, white: [u8; 3]) {
    for (i, &ix) in frame.iter().enumerate() {
        if i >= out.len() {
            break;
        }
        let po = ix as usize * 3;
        let (r, g, b) = match palette.get(po..po + 3) {
            Some(c) => (c[0], c[1], c[2]),
            None => (0, 0, 0),
        };
        out[i] = grb_pixel(r, g, b, bright, white);
    }
}
