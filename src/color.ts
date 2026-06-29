import type { RGB } from './types'

// Color-space conversions and ramp interpolation. Channels are 0-255 at every
// public boundary; intermediate spaces use their natural ranges.

export type InterpSpace = 'rgb' | 'hsl' | 'oklch' | 'step'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x)

/** Shortest-path hue lerp in degrees. */
function lerpHue(h0: number, h1: number, t: number): number {
  let d = ((h1 - h0) % 360 + 540) % 360 - 180
  return (h0 + t * d + 360) % 360
}

// ---- sRGB <-> HSL -------------------------------------------------------

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4; break
    }
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s, l]
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  return [
    Math.round(clamp255((r + m) * 255)),
    Math.round(clamp255((g + m) * 255)),
    Math.round(clamp255((b + m) * 255)),
  ]
}

// ---- sRGB <-> OKLab/OKLCH ----------------------------------------------

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
const toGamma = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

function rgbToOklab([r, g, b]: RGB): [number, number, number] {
  const lr = toLinear(r / 255)
  const lg = toLinear(g / 255)
  const lb = toLinear(b / 255)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToRgb(L: number, a: number, bb: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [
    Math.round(clamp255(toGamma(clamp01(r)) * 255)),
    Math.round(clamp255(toGamma(clamp01(g)) * 255)),
    Math.round(clamp255(toGamma(clamp01(b)) * 255)),
  ]
}

function rgbToOklch(rgb: RGB): [number, number, number] {
  const [L, a, b] = rgbToOklab(rgb)
  const C = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return [L, C, h]
}

function oklchToRgb(L: number, C: number, h: number): RGB {
  const rad = (h * Math.PI) / 180
  return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad))
}

// ---- Two-color interpolation in a chosen space --------------------------

export function mixColors(a: RGB, b: RGB, t: number, space: InterpSpace): RGB {
  if (space === 'step') return t < 0.5 ? a : b
  if (space === 'hsl') {
    const [h0, s0, l0] = rgbToHsl(a)
    const [h1, s1, l1] = rgbToHsl(b)
    return hslToRgb(lerpHue(h0, h1, t), s0 + (s1 - s0) * t, l0 + (l1 - l0) * t)
  }
  if (space === 'oklch') {
    const [L0, C0, h0] = rgbToOklch(a)
    const [L1, C1, h1] = rgbToOklch(b)
    return oklchToRgb(L0 + (L1 - L0) * t, C0 + (C1 - C0) * t, lerpHue(h0, h1, t))
  }
  return [
    Math.round(clamp255(a[0] + (b[0] - a[0]) * t)),
    Math.round(clamp255(a[1] + (b[1] - a[1]) * t)),
    Math.round(clamp255(a[2] + (b[2] - a[2]) * t)),
  ]
}

// ---- Color ramp ---------------------------------------------------------

export interface Stop {
  pos: number // 0-1
  color: RGB
}

/** Sample an ordered color ramp at t (0-1), interpolating in `space`. */
export function sampleRamp(stops: Stop[], t: number, space: InterpSpace): RGB {
  if (stops.length === 0) return [0, 0, 0]
  if (stops.length === 1) return stops[0].color
  const s = [...stops].sort((a, b) => a.pos - b.pos)
  if (t <= s[0].pos) return s[0].color
  if (t >= s[s.length - 1].pos) return s[s.length - 1].color
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (t >= a.pos && t <= b.pos) {
      // Step: hold the lower stop's color across the whole segment (hard cut).
      if (space === 'step') return a.color
      const span = b.pos - a.pos
      const local = span === 0 ? 0 : (t - a.pos) / span
      return mixColors(a.color, b.color, local, space)
    }
  }
  return s[s.length - 1].color
}

// ---- Hex helpers (for <input type="color">) -----------------------------

export function rgbToHex([r, g, b]: RGB): string {
  const h = (n: number) => clamp255(Math.round(n)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function hexToRgb(hex: string): RGB {
  const v = hex.replace('#', '')
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}
