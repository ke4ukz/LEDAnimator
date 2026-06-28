import type { LedPosition, Raster, RGB } from './types'

/** Convert HSV (h,s,v in 0-1) to RGB 0-255. */
function hsv(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r = 0
  let g = 0
  let b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

/** A ring of LEDs lying in the XZ plane, centered at the origin. */
export function ringArrangement(count: number, radius = 4): LedPosition[] {
  const leds: LedPosition[] = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    leds.push({ x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius })
  }
  return leds
}

/**
 * A hardcoded rainbow chase, baked into a fixed-rate raster. Stand-in animation
 * to prove the player loop end-to-end before the authoring pipeline exists.
 */
export function rainbowChaseRaster(numLeds: number, numFrames = 120, fps = 30): Raster {
  const data = new Uint8Array(numFrames * numLeds * 3)
  for (let f = 0; f < numFrames; f++) {
    for (let led = 0; led < numLeds; led++) {
      const hue = (led / numLeds + f / numFrames) % 1
      const [r, g, b] = hsv(hue, 1, 1)
      const base = (f * numLeds + led) * 3
      data[base] = r
      data[base + 1] = g
      data[base + 2] = b
    }
  }
  return { numLeds, numFrames, fps, loop: true, data }
}
