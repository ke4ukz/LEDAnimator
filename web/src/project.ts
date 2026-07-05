import type { RGB } from './types'
import type { Gradient } from './gradient'
import { defaultGradient } from './presets'

// Project model: sources (color textures) → tracks (how a group of LEDs samples
// a source over time) → per-LED assignment. Each LED belongs to exactly one
// track (partition), matching hardware where every LED has a single color source.

/** Per-source color adjustments applied after the source is evaluated, without
 *  touching the gradient's own stops/params. brightness/contrast/saturation are
 *  -1..1 (0 = no change). */
export interface PostFx {
  invert?: boolean
  brightness?: number
  contrast?: number
  saturation?: number
}

export interface GradientSource {
  id: string
  name: string
  kind: 'gradient'
  gradient: Gradient
  post?: PostFx
}

/** A user-supplied image, stored as a data URL so it travels with the project
 *  JSON. It's decoded and stretched to the square source texture on demand. */
export interface ImageSource {
  id: string
  name: string
  kind: 'image'
  image: string
  post?: PostFx
}

export type Source = GradientSource | ImageSource

/** A sampling path across a source's normalized (u,v) space, parameter s ∈ [0,1).
 *  Rotations (`rot`) are in DEGREES. */
export type PathDef =
  | { type: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'sine'; midV: number; amp: number; freq: number; phase: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rot: number }
  | { type: 'spiral'; cx: number; cy: number; r0: number; r1: number; turns: number; rot: number }
  | { type: 'polygon'; cx: number; cy: number; size: number; sides: number; rot: number }
  // Free-drawn point sequence connected by straight segments, with every corner
  // rounded uniformly by `curviness` (0 = sharp, 1 = fullest sweep). `closed`
  // joins the last point back to the first (and rounds that corner too).
  | { type: 'poly'; pts: { x: number; y: number }[]; curviness: number; closed: boolean }

export type PolyPath = Extract<PathDef, { type: 'poly' }>

/** Easing of the segment leaving a keyframe toward the next one. */
export type EaseType = 'linear' | 'smooth' | 'hold'

export interface Keyframe {
  id: string
  /** Time within the loop, 0-1. */
  t: number
  value: number
  ease: EaseType
}

export interface Automation {
  keys: Keyframe[] // kept sorted by t
  /** Keep the first and last keyframe at the same value so the loop is seamless. */
  linkEnds?: boolean
}

/** Track scalars that can be animated with an automation lane. */
export type AutoParam = 'speed' | 'offset' | 'chase'

export interface Track {
  id: string
  name: string
  sourceId: string
  path: PathDef
  /** Path traversals per full animation loop (negative = reverse). */
  speed: number
  /** Starting position along the path, 0-1. */
  offset: number
  /** Per-LED stagger along the path (fraction). 0 = synchronized. */
  chase: number
  /** Optional per-parameter automation; when present it overrides the scalar. */
  automations?: Partial<Record<AutoParam, Automation>>
}

const DEG = Math.PI / 180

/** Evaluate a path at parameter s, returning normalized (u, v). */
export function pathPoint(path: PathDef, s: number): [number, number] {
  switch (path.type) {
    case 'line':
      return [path.x0 + (path.x1 - path.x0) * s, path.y0 + (path.y1 - path.y0) * s]
    case 'sine':
      return [s, path.midV + path.amp * Math.sin(2 * Math.PI * (path.freq * s + path.phase))]
    case 'ellipse': {
      const a = 2 * Math.PI * s
      const x = path.rx * Math.cos(a)
      const y = path.ry * Math.sin(a)
      const r = (path.rot ?? 0) * DEG
      return [path.cx + x * Math.cos(r) - y * Math.sin(r), path.cy + x * Math.sin(r) + y * Math.cos(r)]
    }
    case 'spiral': {
      const a = 2 * Math.PI * path.turns * s + (path.rot ?? 0) * DEG
      const rad = path.r0 + (path.r1 - path.r0) * s
      return [path.cx + rad * Math.cos(a), path.cy + rad * Math.sin(a)]
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(path.sides))
      const r = (path.rot ?? 0) * DEG
      // Vertex k, first at the top (−90°) then rotated by `rot`.
      const vert = (k: number): [number, number] => {
        const ang = r - Math.PI / 2 + (2 * Math.PI * k) / n
        return [path.cx + path.size * Math.cos(ang), path.cy + path.size * Math.sin(ang)]
      }
      const t = s * n
      const edge = Math.floor(t) % n
      const local = t - Math.floor(t)
      const [x0, y0] = vert(edge)
      const [x1, y1] = vert(edge + 1)
      return [x0 + (x1 - x0) * local, y0 + (y1 - y0) * local]
    }
    case 'poly': {
      const f = polyFlat(path)
      if (f.total === 0) return [f.xs[0] ?? 0.5, f.ys[0] ?? 0.5]
      const target = (path.closed ? s - Math.floor(s) : Math.min(1, Math.max(0, s))) * f.total
      // Binary search the cumulative-length table for the containing segment.
      let lo = 0
      let hi = f.cum.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (f.cum[mid] <= target) lo = mid
        else hi = mid
      }
      const seg = f.cum[hi] - f.cum[lo]
      const t = seg > 0 ? (target - f.cum[lo]) / seg : 0
      return [f.xs[lo] + (f.xs[hi] - f.xs[lo]) * t, f.ys[lo] + (f.ys[hi] - f.ys[lo]) * t]
    }
  }
}

// ---- poly path: corner rounding + arc-length sampling -------------------

interface PolyFlat {
  xs: number[]
  ys: number[]
  /** Cumulative arc length at each flattened point (cum[0] = 0). */
  cum: number[]
  total: number
}

// Cache the flattened outline per path object. The store replaces the path
// object on every edit, so a stale entry can never be read.
const polyCache = new WeakMap<object, PolyFlat>()

function polyFlat(path: PolyPath): PolyFlat {
  let f = polyCache.get(path)
  if (!f) {
    f = buildPolyFlat(path)
    polyCache.set(path, f)
  }
  return f
}

const BEZIER_STEPS = 12

/** Flatten the (optionally closed) rounded polyline into a dense point list. */
function buildPolyFlat(path: PolyPath): PolyFlat {
  const V = path.pts
  const xs: number[] = []
  const ys: number[] = []
  const push = (x: number, y: number) => {
    const n = xs.length
    if (n && Math.abs(xs[n - 1] - x) < 1e-9 && Math.abs(ys[n - 1] - y) < 1e-9) return
    xs.push(x)
    ys.push(y)
  }

  if (V.length === 0) return { xs: [0.5], ys: [0.5], cum: [0], total: 0 }
  if (V.length === 1) return { xs: [V[0].x], ys: [V[0].y], cum: [0], total: 0 }

  const n = V.length
  const curv = Math.min(1, Math.max(0, path.curviness))

  // A rounded corner at vertex i: two cut points on the adjacent edges joined by
  // a quadratic Bézier whose control point is the vertex. Returns null for a
  // degenerate (zero-length) edge, meaning "leave this corner sharp".
  const corner = (i: number): { pin: [number, number]; pout: [number, number] } | null => {
    const B = V[i]
    const A = V[(i - 1 + n) % n]
    const C = V[(i + 1) % n]
    const abx = A.x - B.x
    const aby = A.y - B.y
    const cbx = C.x - B.x
    const cby = C.y - B.y
    const lab = Math.hypot(abx, aby)
    const lcb = Math.hypot(cbx, cby)
    if (lab < 1e-6 || lcb < 1e-6) return null
    const cut = curv * 0.5 * Math.min(lab, lcb)
    return {
      pin: [B.x + (abx / lab) * cut, B.y + (aby / lab) * cut],
      pout: [B.x + (cbx / lcb) * cut, B.y + (cby / lcb) * cut],
    }
  }

  const emitCorner = (i: number) => {
    const B = V[i]
    const c = corner(i)
    if (!c || curv <= 0) {
      push(B.x, B.y)
      return
    }
    push(c.pin[0], c.pin[1])
    for (let m = 1; m <= BEZIER_STEPS; m++) {
      const t = m / BEZIER_STEPS
      const mt = 1 - t
      // Quadratic Bézier pin → B (control) → pout.
      push(
        mt * mt * c.pin[0] + 2 * mt * t * B.x + t * t * c.pout[0],
        mt * mt * c.pin[1] + 2 * mt * t * B.y + t * t * c.pout[1],
      )
    }
  }

  if (path.closed) {
    for (let i = 0; i < n; i++) emitCorner(i)
    push(xs[0], ys[0]) // close the loop
  } else {
    push(V[0].x, V[0].y) // start endpoint stays sharp
    for (let i = 1; i < n - 1; i++) emitCorner(i)
    push(V[n - 1].x, V[n - 1].y) // end endpoint stays sharp
  }

  const cum = [0]
  for (let k = 1; k < xs.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]))
  }
  return { xs, ys, cum, total: cum[cum.length - 1] }
}

/** The exact flattened outline of a poly path (normalized), for crisp drawing. */
export function polyOutline(path: PolyPath): [number, number][] {
  const f = polyFlat(path)
  return f.xs.map((x, i) => [x, f.ys[i]])
}

/** Apply post-processing (invert / brightness / contrast / saturation) to a
 *  color. A no-op when `fx` is undefined or all-neutral. Order: brightness →
 *  contrast → saturation → invert, clamped to 0–255. */
export function applyPost(rgb: RGB, fx?: PostFx): RGB {
  if (!fx) return rgb
  let r = rgb[0] / 255
  let g = rgb[1] / 255
  let b = rgb[2] / 255

  const br = fx.brightness ?? 0
  if (br) { r += br; g += br; b += br }

  const k = fx.contrast ?? 0
  if (k) {
    const f = 1 + k // -1..1 → 0..2
    r = (r - 0.5) * f + 0.5
    g = (g - 0.5) * f + 0.5
    b = (b - 0.5) * f + 0.5
  }

  const s = fx.saturation ?? 0
  if (s) {
    const f = 1 + s
    const gray = 0.299 * r + 0.587 * g + 0.114 * b // Rec.601 luma
    r = gray + (r - gray) * f
    g = gray + (g - gray) * f
    b = gray + (b - gray) * f
  }

  if (fx.invert) { r = 1 - r; g = 1 - g; b = 1 - b }

  const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255)
  return [to255(r), to255(g), to255(b)]
}

function applyEase(ease: EaseType, x: number): number {
  if (ease === 'hold') return 0 // value stays at the segment's start until the next key
  if (ease === 'smooth') return x * x * (3 - 2 * x)
  return x
}

/** Evaluate an automation curve at time t (0-1). Flat outside the key range. */
export function evalAutomation(auto: Automation, t: number): number {
  const k = auto.keys
  if (k.length === 0) return 0
  if (t <= k[0].t) return k[0].value
  if (t >= k[k.length - 1].t) return k[k.length - 1].value
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i]
    const b = k[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const local = span === 0 ? 0 : (t - a.t) / span
      return a.value + (b.value - a.value) * applyEase(a.ease, local)
    }
  }
  return k[k.length - 1].value
}

/** A track parameter at time t: the automation curve if animated, else the scalar. */
export function trackParamAt(track: Track, param: AutoParam, t: number): number {
  const auto = track.automations?.[param]
  if (auto && auto.keys.length) return evalAutomation(auto, t)
  return track[param]
}

/**
 * Integrated path phase at a frame: ∫ speed dt. Speed is a rate, so position
 * accumulates. Matches frame*speed/numFrames when speed is constant.
 */
export function trackPhaseAt(track: Track, frame: number, numFrames: number): number {
  let acc = 0
  for (let f = 0; f < frame; f++) acc += trackParamAt(track, 'speed', f / numFrames) / numFrames
  return acc
}

// ---- ids + defaults -----------------------------------------------------

let seq = 0
export const newId = (prefix: string) => `${prefix}${seq++}`

/** Advance the id counter past any ids in `ids` (used when loading a project so
 *  newly-created ids can't collide with loaded ones). */
export function reserveIds(ids: string[]) {
  for (const id of ids) {
    const m = /(\d+)$/.exec(id)
    if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1)
  }
}

export function defaultLinePath(): PathDef {
  return { type: 'line', x0: 0, y0: 0.5, x1: 1, y1: 0.5 }
}

export interface Project {
  sources: Source[]
  tracks: Track[]
  /** trackId for each LED, indexed by LED index (length = number of LEDs). */
  assignments: string[]
}

/** A starter project: one rainbow gradient, one chase track, all LEDs assigned. */
export function defaultProject(numLeds: number): Project {
  const source: Source = { id: newId('src'), name: 'Rainbow', kind: 'gradient', gradient: defaultGradient() }
  const track: Track = {
    id: newId('trk'),
    name: 'Track 1',
    sourceId: source.id,
    path: defaultLinePath(),
    speed: 1,
    offset: 0,
    chase: 1 / numLeds,
  }
  return {
    sources: [source],
    tracks: [track],
    assignments: new Array(numLeds).fill(track.id),
  }
}

/** A truly empty project — no LEDs, sources, or tracks. Used by New/blank slate. */
export function emptyProject(): Project {
  return { sources: [], tracks: [], assignments: [] }
}
