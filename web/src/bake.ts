import type { Project } from './project'
import { evalSource, pathPoint, trackParamAt } from './project'
import type { LedPosition, Raster } from './types'

export const DEFAULT_FRAMES = 120
export const DEFAULT_FPS = 30

const frac = (x: number) => x - Math.floor(x)

/**
 * Composite a project into a fixed-rate raster. Each track owns its assigned
 * LEDs (partition). For each frame, an LED reads its track's source along the
 * path at position `offset + order*chase + phase`, where `phase` is the
 * time-integral of the (possibly animated) speed.
 *
 * Per-LED state (`leds`, optional): an **unassigned** LED is skipped in every
 * track's `order` sequence (so it consumes no slot and the pattern doesn't
 * shift; it's also dropped from the export by `compactRaster`). A **disabled**
 * LED keeps its `order` slot (no shift) but its output is forced to black.
 *
 * The raster stays full-size (one column per LED, unassigned ones black) so the
 * emulator/inspectors can index by LED. Exporters call `compactRaster` to drop
 * unassigned columns.
 */
export function bakeProject(
  project: Project,
  numLeds: number,
  numFrames = DEFAULT_FRAMES,
  fps = DEFAULT_FPS,
  leds?: LedPosition[],
): Raster {
  const data = new Uint8Array(numFrames * numLeds * 3)
  const sourceById = new Map(project.sources.map((s) => [s.id, s]))

  for (const track of project.tracks) {
    const source = sourceById.get(track.sourceId)
    if (!source) continue
    const members = project.assignments
      // Unassigned LEDs are not part of the chain: skip them so they don't
      // consume an `order` step (which would shift everything after them).
      .map((tid, led) => (tid === track.id && !leds?.[led]?.unassigned ? led : -1))
      .filter((led) => led >= 0)
    if (members.length === 0) continue

    // Precompute per-frame phase (∫ speed) and the instantaneous offset/chase.
    const phase = new Float64Array(numFrames)
    const offsetAt = new Float64Array(numFrames)
    const chaseAt = new Float64Array(numFrames)
    let acc = 0
    for (let f = 0; f < numFrames; f++) {
      const t = f / numFrames
      phase[f] = acc
      acc += trackParamAt(track, 'speed', t) / numFrames
      offsetAt[f] = trackParamAt(track, 'offset', t)
      chaseAt[f] = trackParamAt(track, 'chase', t)
    }

    members.forEach((led, rank) => {
      // Disabled LEDs keep their rank slot (no shift) but emit black.
      const black = leds?.[led]?.disabled ?? false
      // The chase walks the animation index (default = wiring rank); shared
      // values make LEDs animate together.
      const ord = leds?.[led]?.animIndex ?? rank
      for (let f = 0; f < numFrames; f++) {
        const base = (f * numLeds + led) * 3
        if (black) {
          data[base] = data[base + 1] = data[base + 2] = 0
          continue
        }
        const s = frac(offsetAt[f] + ord * chaseAt[f] + phase[f])
        const [u, v] = pathPoint(track.path, s)
        const [r, g, b] = evalSource(source, u, v)
        data[base] = r
        data[base + 1] = g
        data[base + 2] = b
      }
    })
  }

  return { numLeds, numFrames, fps, loop: true, data }
}

/**
 * Drop unassigned LEDs' columns to produce the physical export stream (they
 * aren't wired, so they get no slot). Assigned LEDs — including disabled/black
 * ones, which DO occupy a chain slot — are kept in order. Returns the raster
 * unchanged when nothing is unassigned.
 */
export function compactRaster(raster: Raster, leds: LedPosition[]): Raster {
  const keep: number[] = []
  for (let i = 0; i < raster.numLeds; i++) if (!leds[i]?.unassigned) keep.push(i)
  if (keep.length === raster.numLeds) return raster

  const m = keep.length
  const data = new Uint8Array(raster.numFrames * m * 3)
  for (let f = 0; f < raster.numFrames; f++) {
    for (let j = 0; j < m; j++) {
      const src = (f * raster.numLeds + keep[j]) * 3
      const dst = (f * m + j) * 3
      data[dst] = raster.data[src]
      data[dst + 1] = raster.data[src + 1]
      data[dst + 2] = raster.data[src + 2]
    }
  }
  return { ...raster, numLeds: m, data }
}
