import type { Raster } from '../types'

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
//   17  3    reserved
//   20  ...  for each frame: numLeds × (R,G,B)
//
// A leader-only file is a header with role=2 and NO pixel data (numFrames+fps
// give the master clock; it runs the beacon and drives no strip).

export const HEADER_SIZE = 20

/** Sync roles, matching the header `role` byte and the firmware. */
export const ROLE = {
  standalone: 0,
  leader: 1, // leader + controller: runs the clock/beacon AND drives its strip
  leaderOnly: 2, // dedicated leader: runs the clock/beacon, drives no strip (header-only file)
  follower: 3,
} as const

/** Per-file sync metadata stamped into the header (all default to a plain
 *  standalone device). */
export interface LedaMeta {
  role?: number
  group?: number
  device?: number
}

/** Bytes a raster will occupy as a LEDA file (no allocation). */
export function estimateBytes(raster: Raster): number {
  return HEADER_SIZE + raster.numFrames * raster.numLeds * 3
}

function writeHeader(
  dv: DataView,
  out: Uint8Array,
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
  dv.setUint8(5, 0) // format: RGB888
  dv.setUint16(6, numLeds, true)
  dv.setUint32(8, numFrames, true)
  dv.setUint16(12, fps, true)
  dv.setUint8(14, (meta.role ?? ROLE.standalone) & 0xff)
  dv.setUint8(15, (meta.group ?? 0) & 0xff)
  dv.setUint8(16, (meta.device ?? 0) & 0xff)
  // 17-19 reserved (0)
}

/** Encode a raster to the LEDA binary, stamping the sync metadata into the header. */
export function encodeRaster(raster: Raster, meta: LedaMeta = {}): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + raster.data.length)
  const dv = new DataView(out.buffer)
  writeHeader(dv, out, raster.numLeds, raster.numFrames, raster.fps, meta)
  out.set(raster.data, HEADER_SIZE)
  return out
}

/** Encode a leader-only file: just the header (role=leader-only, no pixel data).
 *  The device runs the master clock + beacon from numFrames/fps and drives no
 *  strip, so followers have a reference even where no strip is wired. */
export function encodeLeaderOnly(numFrames: number, fps: number, group = 0, device = 0): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE)
  const dv = new DataView(out.buffer)
  writeHeader(dv, out, 0, numFrames, fps, { role: ROLE.leaderOnly, group, device })
  return out
}
