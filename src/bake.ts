import type { Gradient } from './gradient'
import { evalGradient } from './gradient'
import type { Raster } from './types'

/**
 * Bake a gradient into a fixed-rate raster using the default sampling: a
 * horizontal scan (v = 0.5) with a per-frame phase offset so the pattern
 * chases around the LEDs. This is a stand-in for the real per-track path +
 * speed system; it proves the non-destructive gradient → raster → play loop.
 */
export function bakeGradientRaster(
  g: Gradient,
  numLeds: number,
  numFrames = 120,
  fps = 30,
): Raster {
  const data = new Uint8Array(numFrames * numLeds * 3)
  for (let f = 0; f < numFrames; f++) {
    const phase = f / numFrames
    for (let led = 0; led < numLeds; led++) {
      const u = (led / numLeds + phase) % 1
      const [r, g2, b] = evalGradient(g, u, 0.5)
      const base = (f * numLeds + led) * 3
      data[base] = r
      data[base + 1] = g2
      data[base + 2] = b
    }
  }
  return { numLeds, numFrames, fps, loop: true, data }
}
