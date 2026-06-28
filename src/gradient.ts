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
  | { type: 'bilinear'; tl: RGB; tr: RGB; bl: RGB; br: RGB; interp: InterpSpace }

const TAU = Math.PI * 2
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const dist = (dx: number, dy: number, metric: RadialMetric) =>
  metric === 'chebyshev' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy)

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
]

export function defaultGradient(): Gradient {
  return PRESETS[0].make()
}
