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
  // Clamp to the unit square: sampling outside the gradient (e.g. a sine path
  // running off the top/bottom) gives the edge color — consistent across all
  // field types, and avoids bilinear extrapolating out of gamut.
  u = clamp01(u)
  v = clamp01(v)
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
