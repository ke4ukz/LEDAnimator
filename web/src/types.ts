// Core data model for the LED Animator.
//
// The canonical, platform-agnostic artifact is a fixed-rate raster: one global
// frame interval, row = LED, column = frame. All authoring cleverness (paths,
// speed curves, chases, multi-texture compositing) bakes down into this. The
// in-browser emulator plays it by stepping, identically to how firmware will.

/** A single RGB color, channels 0-255. */
export type RGB = [number, number, number]

/** World-space position of one LED in the 3D arrangement. */
export interface LedPosition {
  x: number
  y: number
  z: number
  /** Blackout: stays in the chain and in the `order` sequence (so the pattern
   *  doesn't shift), but its output is forced to black. For dead/intentionally
   *  dark pixels. */
  disabled?: boolean
  /** Not part of the physical chain at all: skipped in every track's `order`
   *  sequence AND dropped from the exported stream (reduces numLeds). For
   *  layout/reference LEDs that aren't wired. */
  unassigned?: boolean
}

/**
 * A baked, fixed-rate animation.
 *
 * `data` is frame-major and tightly packed:
 *   data[(frame * numLeds + led) * 3 + channel]
 * so the slice for a single frame is contiguous — the shape a microcontroller
 * reads one column at a time.
 */
export interface Raster {
  numLeds: number
  numFrames: number
  /** Global playback rate. frameIntervalMs = 1000 / fps. */
  fps: number
  loop: boolean
  /** Length === numFrames * numLeds * 3. */
  data: Uint8Array
}

/** Read one LED's color for a given frame out of a raster. */
export function sampleRaster(raster: Raster, frame: number, led: number): RGB {
  const base = (frame * raster.numLeds + led) * 3
  const { data } = raster
  return [data[base], data[base + 1], data[base + 2]]
}
