import type { RGB } from './types'
import { type InterpSpace, mixColors, sampleRamp, type Stop } from './color'

// A gradient is a parametric, non-destructive definition evaluated on demand
// over normalized image coords (u, v) in [0, 1]. Field-based types map (u,v) to
// a ramp parameter t; bilinear interpolates corner colors directly.

export interface GradientStop extends Stop {
  id: string
}

export type RadialMetric = 'euclidean' | 'chebyshev' // circle vs square iso-lines
export type DualCombine = 'nearest' | 'blend' | 'difference'

interface RampBased {
  stops: GradientStop[]
  interp: InterpSpace
}

export type Gradient =
  | ({ type: 'linear'; angle: number } & RampBased)
  | ({ type: 'radial'; cx: number; cy: number; radius: number; metric: RadialMetric } & RampBased)
  | ({ type: 'conic'; cx: number; cy: number; angle: number } & RampBased)
  | ({
      type: 'dualRadial'
      c1x: number; c1y: number
      c2x: number; c2y: number
      radius: number
      combine: DualCombine
    } & RampBased)
  | ({ type: 'noise'; scale: number; octaves: number; seed: number } & RampBased)
  | { type: 'bilinear'; tl: RGB; tr: RGB; bl: RGB; br: RGB; interp: InterpSpace }

const TAU = Math.PI * 2
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const dist = (dx: number, dy: number, metric: RadialMetric) =>
  metric === 'chebyshev' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy)

// ---- Tileable value noise (for the flicker field) -----------------------

/** Integer hash → [0,1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 0x9e3779b1) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Value noise that tiles over [0,1) with integer period `freq`. */
function valueNoise(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq
  const y = v * freq
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = fade(x - x0)
  const fy = fade(y - y0)
  const wrap = (n: number) => ((n % freq) + freq) % freq
  const X0 = wrap(x0)
  const X1 = wrap(x0 + 1)
  const Y0 = wrap(y0)
  const Y1 = wrap(y0 + 1)
  const nx0 = hash2(X0, Y0, seed) + (hash2(X1, Y0, seed) - hash2(X0, Y0, seed)) * fx
  const nx1 = hash2(X0, Y1, seed) + (hash2(X1, Y1, seed) - hash2(X0, Y1, seed)) * fx
  return nx0 + (nx1 - nx0) * fy
}

/** Fractal (multi-octave) tileable value noise in [0,1]. */
function fbm(u: number, v: number, baseFreq: number, octaves: number, seed: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = Math.max(1, Math.round(baseFreq))
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, f, seed + o * 101)
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

/** Map (u,v) to a ramp parameter t in [0,1] for field-based gradients. */
function fieldT(g: Gradient, u: number, v: number): number {
  switch (g.type) {
    case 'linear': {
      const c = Math.cos(g.angle)
      const s = Math.sin(g.angle)
      const norm = Math.abs(c) + Math.abs(s) || 1
      return clamp01(((u - 0.5) * c + (v - 0.5) * s) / norm + 0.5)
    }
    case 'radial':
      return clamp01(dist(u - g.cx, v - g.cy, g.metric) / (g.radius || 1e-6))
    case 'conic': {
      let a = (Math.atan2(v - g.cy, u - g.cx) - g.angle) / TAU
      a -= Math.floor(a) // wrap into [0,1)
      return a
    }
    case 'dualRadial': {
      const d1 = Math.hypot(u - g.c1x, v - g.c1y)
      const d2 = Math.hypot(u - g.c2x, v - g.c2y)
      const r = g.radius || 1e-6
      if (g.combine === 'nearest') return clamp01(Math.min(d1, d2) / r)
      if (g.combine === 'blend') return clamp01((d1 + d2) / 2 / r)
      return clamp01(0.5 + (d1 - d2) / (2 * r)) // difference
    }
    case 'noise':
      // Expand contrast around 0.5: fbm averages to the middle, so stretch it
      // to recover full dark/bright flicker pops (clipping at the extremes).
      return clamp01((fbm(u, v, g.scale, g.octaves, g.seed) - 0.5) * 1.7 + 0.5)
    default:
      return 0
  }
}

/** Evaluate a gradient color at normalized coords (u, v). */
export function evalGradient(g: Gradient, u: number, v: number): RGB {
  if (g.type === 'bilinear') {
    const top = mixColors(g.tl, g.tr, u, g.interp)
    const bottom = mixColors(g.bl, g.br, u, g.interp)
    return mixColors(top, bottom, v, g.interp)
  }
  return sampleRamp(g.stops, fieldT(g, u, v), g.interp)
}

// ---- Stops / presets ----------------------------------------------------

let stopSeq = 0
export function makeStop(pos: number, color: RGB): GradientStop {
  return { id: `s${stopSeq++}`, pos, color }
}

/** Evenly-spaced hue ring as ramp stops (red → ... → red) for rainbows. */
function rainbowStops(n = 7): GradientStop[] {
  const stops: GradientStop[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const h = (t * 360) % 360
    // HSL hue at full sat/half light, computed inline to avoid a circular import
    stops.push(makeStop(t, hslQuick(h)))
  }
  return stops
}

function hslQuick(h: number): RGB {
  const c = 1
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = 0
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

export interface GradientPreset {
  name: string
  make: () => Gradient
}

export const PRESETS: GradientPreset[] = [
  {
    name: 'Linear rainbow',
    make: () => ({ type: 'linear', angle: 0, interp: 'hsl', stops: rainbowStops() }),
  },
  {
    name: 'Conic rainbow',
    make: () => ({ type: 'conic', cx: 0.5, cy: 0.5, angle: 0, interp: 'hsl', stops: rainbowStops() }),
  },
  {
    name: 'Sunset',
    make: () => ({
      type: 'linear', angle: 0, interp: 'oklch',
      stops: [
        makeStop(0, [20, 20, 60]),
        makeStop(0.45, [200, 60, 90]),
        makeStop(0.7, [255, 140, 60]),
        makeStop(1, [255, 220, 120]),
      ],
    }),
  },
  {
    name: 'Fire (radial)',
    make: () => ({
      type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, metric: 'euclidean', interp: 'oklch',
      stops: [
        makeStop(0, [255, 240, 180]),
        makeStop(0.4, [255, 120, 20]),
        makeStop(0.8, [140, 20, 0]),
        makeStop(1, [10, 0, 0]),
      ],
    }),
  },
  {
    name: 'Dual radial',
    make: () => ({
      type: 'dualRadial', c1x: 0.25, c1y: 0.5, c2x: 0.75, c2y: 0.5,
      radius: 0.5, combine: 'nearest', interp: 'oklch',
      stops: [makeStop(0, [255, 255, 255]), makeStop(1, [10, 20, 80])],
    }),
  },
  {
    name: 'Corners (bilinear)',
    make: () => ({
      type: 'bilinear', interp: 'oklch',
      tl: [230, 40, 90], tr: [250, 210, 40], bl: [40, 90, 230], br: [40, 220, 140],
    }),
  },
  {
    name: 'Flame flicker',
    make: () => ({
      type: 'noise', scale: 12, octaves: 3, seed: 1337, interp: 'oklch',
      stops: [
        makeStop(0, [8, 0, 0]),
        makeStop(0.3, [120, 14, 0]),
        makeStop(0.55, [230, 50, 0]),
        makeStop(0.75, [255, 130, 15]),
        makeStop(0.9, [255, 205, 60]),
        makeStop(1, [255, 245, 200]),
      ],
    }),
  },
]

export function defaultGradient(): Gradient {
  return PRESETS[0].make()
}
