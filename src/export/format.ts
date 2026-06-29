import type { Raster } from '../types'

// The canonical on-device binary: a 16-byte header + frame-major RGB888 pixels.
// All exporters/controllers read this same "LEDA v1" format.
//
//   off size field
//   0   4    magic 'LEDA'
//   4   1    version (1)
//   5   1    pixel format (0 = RGB888)
//   6   2    numLeds   (uint16 LE)
//   8   4    numFrames (uint32 LE)
//   12  2    fps       (uint16 LE)
//   14  2    reserved
//   16  ...  for each frame: numLeds × (R,G,B)

export const HEADER_SIZE = 16

/** Bytes a raster will occupy as LEDA v1 (no allocation). */
export function estimateBytes(raster: Raster): number {
  return HEADER_SIZE + raster.numFrames * raster.numLeds * 3
}

/** Encode a raster to the LEDA v1 binary. */
export function encodeRaster(raster: Raster): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + raster.data.length)
  const dv = new DataView(out.buffer)
  out[0] = 0x4c // L
  out[1] = 0x45 // E
  out[2] = 0x44 // D
  out[3] = 0x41 // A
  dv.setUint8(4, 1) // version
  dv.setUint8(5, 0) // format: RGB888
  dv.setUint16(6, raster.numLeds, true)
  dv.setUint32(8, raster.numFrames, true)
  dv.setUint16(12, raster.fps, true)
  out.set(raster.data, HEADER_SIZE)
  return out
}
