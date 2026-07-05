import type { RGB } from './types'
import { type Gradient, type GradientStop, makeStop } from './gradient'

// Gradient presets as plain data. To add one, append an entry to PRESETS — no
// code changes needed. Ramp stops are written without ids ({ pos, color }); ids
// are assigned when a preset is instantiated.

export interface StopSpec {
  pos: number
  color: RGB
}

/** A Gradient with id-less ramp stops (distributes over the Gradient union). */
type Despecify<G> = G extends { stops: GradientStop[] }
  ? Omit<G, 'stops'> & { stops: StopSpec[] }
  : G
export type GradientSpec = Despecify<Gradient>

export interface Preset {
  name: string
  gradient: GradientSpec
}

/** Turn a data-only preset gradient into a live Gradient (assigning stop ids). */
export function instantiateGradient(spec: GradientSpec): Gradient {
  if ('stops' in spec) {
    return { ...spec, stops: spec.stops.map((s) => makeStop(s.pos, s.color)) } as Gradient
  }
  return spec as Gradient
}

// Red → … → red. The six sRGB primaries, but positioned by their OKLCH hue
// angle (not evenly) and interpolated in OKLCH, so the hue sweeps at a constant
// perceptual rate — a visually uniform rainbow (e.g. as a conic). Evenly-spaced
// positions look lopsided because these colors' hues aren't evenly distributed.
const RAINBOW: StopSpec[] = [
  { pos: 0, color: [255, 0, 0] }, //   red     OKLCH ~29°
  { pos: 0.224, color: [255, 255, 0] }, // yellow  ~110°
  { pos: 0.315, color: [0, 255, 0] }, //   green   ~143°
  { pos: 0.46, color: [0, 255, 255] }, //  cyan    ~195°
  { pos: 0.652, color: [0, 0, 255] }, //   blue    ~264°
  { pos: 0.831, color: [255, 0, 255] }, // magenta ~328°
  { pos: 1, color: [255, 0, 0] }, //   red (wrap)
]

// The startup gradient, defined independently of PRESETS so editing/removing
// presets can never change (or break) the app's default.
const DEFAULT_SPEC: GradientSpec = { type: 'linear', angle: 0, interp: 'oklch', stops: RAINBOW }

export const PRESETS: Preset[] = [
  {
    name: 'Black & white',
    gradient: {
      type: 'linear', angle: 0, interp: 'rgb',
      stops: [
        { pos: 0, color: [0, 0, 0] },
        { pos: 1, color: [255, 255, 255] },
      ],
    },
  },
  {
    name: 'Stripes (hard)',
    gradient: {
      type: 'linear', angle: 0, interp: 'step',
      stops: [
        { pos: 0, color: [220, 30, 30] },
        { pos: 1 / 3, color: [255, 255, 255] },
        { pos: 2 / 3, color: [40, 160, 60] },
      ],
    },
  },
  {
    name: 'Linear rainbow',
    gradient: DEFAULT_SPEC,
  },
  {
    name: 'Conic rainbow',
    gradient: { type: 'conic', cx: 0.5, cy: 0.5, angle: 0, interp: 'oklch', stops: RAINBOW },
  },
  {
    name: 'Sunset',
    gradient: {
      type: 'linear', angle: 0, interp: 'oklch',
      stops: [
        { pos: 0, color: [20, 20, 60] },
        { pos: 0.45, color: [200, 60, 90] },
        { pos: 0.7, color: [255, 140, 60] },
        { pos: 1, color: [255, 220, 120] },
      ],
    },
  },
  {
    name: 'Fire (radial)',
    gradient: {
      type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, metric: 'euclidean', interp: 'oklch',
      stops: [
        { pos: 0, color: [255, 240, 180] },
        { pos: 0.4, color: [255, 120, 20] },
        { pos: 0.8, color: [140, 20, 0] },
        { pos: 1, color: [10, 0, 0] },
      ],
    },
  },
  {
    name: 'Dual radial',
    gradient: {
      type: 'dualRadial', c1x: 0.25, c1y: 0.5, c2x: 0.75, c2y: 0.5,
      radius: 0.5, combine: 'nearest', interp: 'oklch',
      stops: [
        { pos: 0, color: [255, 255, 255] },
        { pos: 1, color: [10, 20, 80] },
      ],
    },
  },
  {
    name: 'Corners (bilinear)',
    gradient: {
      type: 'bilinear', interp: 'oklch',
      tl: [230, 40, 90], tr: [250, 210, 40], bl: [40, 90, 230], br: [40, 220, 140],
    },
  },
  {
    name: 'Flame flicker',
    gradient: {
      type: 'noise', scale: 12, octaves: 3, seed: 1337, interp: 'oklch',
      stops: [
        { pos: 0, color: [8, 0, 0] },
        { pos: 0.3, color: [120, 14, 0] },
        { pos: 0.55, color: [230, 50, 0] },
        { pos: 0.75, color: [255, 130, 15] },
        { pos: 0.9, color: [255, 205, 60] },
        { pos: 1, color: [255, 245, 200] },
      ],
    },
  },
]

/** The starter gradient. Independent of PRESETS, so editing the preset list
 *  (renaming/removing/reordering) can never change or break startup. */
export function defaultGradient(): Gradient {
  return instantiateGradient(DEFAULT_SPEC)
}
