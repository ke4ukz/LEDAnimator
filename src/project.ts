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
}

const frac = (x: number) => x - Math.floor(x)

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

/**
 * Sample one LED's color for a frame: walk the track's path by time (speed) and
 * the LED's order within the track (chase), then read the source there.
 */
export function sampleTrack(
  source: Source,
  track: Track,
  orderInTrack: number,
  frame: number,
  numFrames: number,
): RGB {
  const s = frac(track.offset + orderInTrack * track.chase + (frame / numFrames) * track.speed)
  const [u, v] = pathPoint(track.path, s)
  return evalSource(source, u, v)
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
