import type { Project } from './project'
import { sampleTrack } from './project'
import type { Raster } from './types'

export const DEFAULT_FRAMES = 120
export const DEFAULT_FPS = 30

/**
 * Composite a project into a fixed-rate raster. Each track owns its assigned
 * LEDs (partition); for every frame each LED reads its track's source along the
 * track's path, advanced by time (speed) and its order within the track
 * (chase). Unassigned LEDs stay black. This is the canonical artifact the
 * emulator plays and exporters consume.
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
    // LEDs on this track, in ascending index order → their order drives chase.
    const members = project.assignments
      .map((tid, led) => (tid === track.id ? led : -1))
      .filter((led) => led >= 0)

    members.forEach((led, order) => {
      for (let f = 0; f < numFrames; f++) {
        const [r, g, b] = sampleTrack(source, track, order, f, numFrames)
        const base = (f * numLeds + led) * 3
        data[base] = r
        data[base + 1] = g
        data[base + 2] = b
      }
    })
  }

  return { numLeds, numFrames, fps, loop: true, data }
}
