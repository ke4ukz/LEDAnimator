import type { Project } from './project'
import { evalSource, pathPoint, trackParamAt } from './project'
import type { Raster } from './types'

export const DEFAULT_FRAMES = 120
export const DEFAULT_FPS = 30

const frac = (x: number) => x - Math.floor(x)

/**
 * Composite a project into a fixed-rate raster. Each track owns its assigned
 * LEDs (partition). For each frame, an LED reads its track's source along the
 * path at position `offset + order*chase + phase`, where `phase` is the
 * time-integral of the (possibly animated) speed. Unassigned LEDs stay black.
 * This is the canonical artifact the emulator plays and exporters consume.
 */
export function bakeProject(
  project: Project,
  numLeds: number,
  numFrames = DEFAULT_FRAMES,
  fps = DEFAULT_FPS,
): Raster {
  const data = new Uint8Array(numFrames * numLeds * 3)
  const sourceById = new Map(project.sources.map((s) => [s.id, s]))

  for (const track of project.tracks) {
    const source = sourceById.get(track.sourceId)
    if (!source) continue
    const members = project.assignments
      .map((tid, led) => (tid === track.id ? led : -1))
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

    members.forEach((led, order) => {
      for (let f = 0; f < numFrames; f++) {
        const s = frac(offsetAt[f] + order * chaseAt[f] + phase[f])
        const [u, v] = pathPoint(track.path, s)
        const [r, g, b] = evalSource(source, u, v)
        const base = (f * numLeds + led) * 3
        data[base] = r
        data[base + 1] = g
        data[base + 2] = b
      }
    })
  }

  return { numLeds, numFrames, fps, loop: true, data }
}
