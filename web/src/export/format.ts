import type { Raster } from '../types'
import { buildIndexed, type IndexedResult } from './palette'

// The canonical on-device binary: a 20-byte header + frame-major RGB888 pixels.
// All exporters/controllers read this same "LEDA" format.
//
//   off size field
//   0   4    magic 'LEDA'
//   4   1    version (1)
//   5   1    pixel format (0 = RGB888)
//   6   2    numLeds   (uint16 LE)
//   8   4    numFrames (uint32 LE)
//   12  2    fps       (uint16 LE)
//   14  1    role      (0 standalone, 1 leader, 2 leader-only, 3 follower)
//   15  1    group id  (0-255 sync group / installation)
//   16  1    device id (0-255 render-slice: which device this file is for)
//   17  1    sync flags: bits 0-1 = on-sync-loss (0 indicate,1 silent,2 blackout);
//            bit 2 = startup (0 wait-for-sync, 1 start-and-go)
//   18  2    reserved
//   20  ...  for each frame: numLeds × (R,G,B)
//
// A leader-only file is a header with role=2 and NO pixel data (numFrames+fps
// give the master clock; it runs the beacon and drives no strip).

export const HEADER_SIZE = 20

/** Pixel-format byte (header offset 5). */
export const PIXEL_FORMAT = {
  rgb888: 0, // 3 bytes/LED
  rgb565: 1, // 2 bytes/LED (5-6-5, little-endian)
  indexed: 2, // palette block + 1 index byte/LED
} as const
export type PixelFormat = (typeof PIXEL_FORMAT)[keyof typeof PIXEL_FORMAT]

/** Sync roles, matching the header `role` byte and the firmware. */
export const ROLE = {
  standalone: 0,
  leader: 1, // leader + controller: runs the clock/beacon AND drives its strip
  leaderOnly: 2, // dedicated leader: runs the clock/beacon, drives no strip (header-only file)
  follower: 3,
  auto: 4, // first-boot election: at boot, become leader if no beacon is heard, else follower
} as const

/** A follower's behavior when it loses its leader (header byte 17, bits 0-1). */
export const LOSS = {
  indicate: 0, // keep playing (free-run) + amber LED0 "searching" indicator
  silent: 1, // keep playing (free-run), no on-strip indication
  blackout: 2, // go dark until the leader returns
} as const

/** A follower's boot behavior before its first sync (header byte 17, bit 2). */
export const STARTUP = {
  wait: 0, // hold dark ("acquiring") until the first beacon, then come up in sync
  go: 1, // free-run its own animation immediately; snap into sync when a beacon arrives
} as const

/** Per-file sync metadata stamped into the header (all default to a plain
 *  standalone device). */
export interface LedaMeta {
  role?: number
  group?: number
  device?: number
  lossPolicy?: number
  startup?: number
}

/** Bytes a raster will occupy as an RGB888 LEDA file (no allocation). */
export function estimateBytes(raster: Raster): number {
  return estimateBytesFor(raster, PIXEL_FORMAT.rgb888)
}

/** Bytes a raster will occupy in a given pixel format (no allocation). For
 *  `indexed`, pass the palette entry count (defaults to the 256 worst case). */
export function estimateBytesFor(raster: Raster, format: number, paletteCount = 256): number {
  const cells = raster.numFrames * raster.numLeds
  switch (format) {
    case PIXEL_FORMAT.rgb565:
      return HEADER_SIZE + cells * 2
    case PIXEL_FORMAT.indexed:
      return HEADER_SIZE + PALETTE_HEADER + paletteCount * 3 + cells
    default:
      return HEADER_SIZE + cells * 3
  }
}

/** Size of the indexed palette block's own header (a uint16 entry count). */
const PALETTE_HEADER = 2

function writeHeader(
  dv: DataView,
  out: Uint8Array,
  format: number,
  numLeds: number,
  numFrames: number,
  fps: number,
  meta: LedaMeta,
) {
  out[0] = 0x4c // L
  out[1] = 0x45 // E
  out[2] = 0x44 // D
  out[3] = 0x41 // A
  dv.setUint8(4, 1) // version
  dv.setUint8(5, format & 0xff) // pixel format (0 RGB888 / 1 RGB565 / 2 indexed)
  dv.setUint16(6, numLeds, true)
  dv.setUint32(8, numFrames, true)
  dv.setUint16(12, fps, true)
  dv.setUint8(14, (meta.role ?? ROLE.standalone) & 0xff)
  dv.setUint8(15, (meta.group ?? 0) & 0xff)
  dv.setUint8(16, (meta.device ?? 0) & 0xff)
  // sync flags: bits 0-1 = on-loss policy, bit 2 = start-and-go (else wait-for-sync)
  dv.setUint8(17, ((meta.lossPolicy ?? LOSS.indicate) & 0x03) | (((meta.startup ?? STARTUP.wait) & 1) << 2))
  // 18-19 reserved (0)
}

/** Encode a raster to the LEDA binary (RGB888), stamping sync metadata. */
export function encodeRaster(raster: Raster, meta: LedaMeta = {}): Uint8Array {
  return encodeRasterAs(raster, PIXEL_FORMAT.rgb888, meta)
}

/** Encode a raster in the given pixel format. For `indexed`, an already-built
 *  `IndexedResult` can be passed to avoid re-quantizing (the export UI builds one
 *  to check losslessness + size); otherwise it's built here with a 256 max. */
export function encodeRasterAs(
  raster: Raster,
  format: number,
  meta: LedaMeta = {},
  indexed?: IndexedResult,
): Uint8Array {
  if (format === PIXEL_FORMAT.rgb565) return encode565(raster, meta)
  if (format === PIXEL_FORMAT.indexed) return encodeIndexed(raster, indexed ?? buildIndexed(raster.data), meta)
  // RGB888
  const out = new Uint8Array(HEADER_SIZE + raster.data.length)
  writeHeader(new DataView(out.buffer), out, PIXEL_FORMAT.rgb888, raster.numLeds, raster.numFrames, raster.fps, meta)
  out.set(raster.data, HEADER_SIZE)
  return out
}

/** Pack RGB888 → RGB565 (5-6-5), little-endian, 2 bytes per LED. */
function encode565(raster: Raster, meta: LedaMeta): Uint8Array {
  const cells = raster.numFrames * raster.numLeds
  const out = new Uint8Array(HEADER_SIZE + cells * 2)
  const dv = new DataView(out.buffer)
  writeHeader(dv, out, PIXEL_FORMAT.rgb565, raster.numLeds, raster.numFrames, raster.fps, meta)
  const src = raster.data
  for (let p = 0; p < cells; p++) {
    const r = src[p * 3]
    const g = src[p * 3 + 1]
    const b = src[p * 3 + 2]
    const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
    dv.setUint16(HEADER_SIZE + p * 2, v, true)
  }
  return out
}

/** Indexed: header + palette block (uint16 count + count×RGB888) + index bytes. */
function encodeIndexed(raster: Raster, idx: IndexedResult, meta: LedaMeta): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + PALETTE_HEADER + idx.palette.length + idx.indices.length)
  const dv = new DataView(out.buffer)
  writeHeader(dv, out, PIXEL_FORMAT.indexed, raster.numLeds, raster.numFrames, raster.fps, meta)
  dv.setUint16(HEADER_SIZE, idx.count, true)
  out.set(idx.palette, HEADER_SIZE + PALETTE_HEADER)
  out.set(idx.indices, HEADER_SIZE + PALETTE_HEADER + idx.palette.length)
  return out
}

/** Encode a leader-only file: just the header (role=leader-only, no pixel data).
 *  The device runs the master clock + beacon from numFrames/fps and drives no
 *  strip, so followers have a reference even where no strip is wired. */
export function encodeLeaderOnly(numFrames: number, fps: number, group = 0, device = 0): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE)
  const dv = new DataView(out.buffer)
  // No pixel data, so the pixel format is moot — record RGB888.
  writeHeader(dv, out, PIXEL_FORMAT.rgb888, 0, numFrames, fps, { role: ROLE.leaderOnly, group, device })
  return out
}
