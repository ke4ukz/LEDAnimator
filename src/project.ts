import type { RGB } from './types'
import { type Gradient, defaultGradient } from './gradient'
import { evalGradient } from './gradient'

// Project model: sources (color textures) → tracks (how a group of LEDs samples
// a source over time) → per-LED assignment. Each LED belongs to exactly one
// track (partition), matching hardware where every LED has a single color source.

export interface GradientSource {
  id: string
  name: string
  kind: 'gradient'
  gradient: Gradient
}

// Images will join this union later.
export type Source = GradientSource

/** A sampling path across a source's normalized (u,v) space, parameter s ∈ [0,1). */
export type PathDef =
  | { type: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'sine'; midV: number; amp: number; freq: number; phase: number }
  | { type: 'circle'; cx: number; cy: number; r: number }

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

/** Evaluate a path at parameter s, returning normalized (u, v). */
export function pathPoint(path: PathDef, s: number): [number, number] {
  switch (path.type) {
    case 'line':
      return [path.x0 + (path.x1 - path.x0) * s, path.y0 + (path.y1 - path.y0) * s]
    case 'sine':
      return [s, path.midV + path.amp * Math.sin(2 * Math.PI * (path.freq * s + path.phase))]
    case 'circle': {
      const a = 2 * Math.PI * s
      return [path.cx + path.r * Math.cos(a), path.cy + path.r * Math.sin(a)]
    }
  }
}

export function evalSource(source: Source, u: number, v: number): RGB {
  return evalGradient(source.gradient, u, v)
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
