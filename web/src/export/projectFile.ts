import { strFromU8, unzipSync } from 'fflate'
import type { LedPosition } from '../types'
import type { LabelMode, Source, Track } from '../project'

// The editable project state, serialized to JSON. The baked raster is NOT
// stored (it's derived) — it's re-baked from this on load.

/** Per-device firmware settings, keyed by device id in `ProjectFile.devices`. */
export interface DeviceSettings {
  name?: string
  /** GPIO pin the strip data line is wired to. */
  pin?: number
  /** Startup brightness, 0-1. */
  brightness?: number
}

export interface ProjectFile {
  format: 'led-animator-project'
  version: number
  id: string
  name: string
  fps: number
  numFrames: number
  leds: LedPosition[]
  sources: Source[]
  tracks: Track[]
  assignments: string[]
  /** Program number for this pattern (the selection id a device group uses); the
   *  export filename is prefixed with it. Optional for older files (default 1). */
  program?: number
  /** Per-device firmware settings, keyed by device id (see `LedPosition.device`). */
  devices?: Record<string, DeviceSettings>
  // `labelMode` is current; `showLabels` is read from older files for back-compat.
  display: { ledScale: number; ledShape: 'sphere' | 'cube'; labelMode?: LabelMode; showLabels?: boolean }
}

export function serializeProjectFile(file: ProjectFile): string {
  return JSON.stringify(file, null, 2)
}

/** Parse + validate a project JSON string. Throws on anything unexpected. */
export function parseProjectFile(text: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('not valid JSON')
  }
  const f = data as Partial<ProjectFile>
  if (f?.format !== 'led-animator-project') throw new Error('not a LED Animator project file')
  if (!Array.isArray(f.leds) || !Array.isArray(f.sources) || !Array.isArray(f.tracks) || !Array.isArray(f.assignments)) {
    throw new Error('project file is missing required fields')
  }
  if (typeof f.fps !== 'number' || typeof f.numFrames !== 'number') {
    throw new Error('project file is missing timing')
  }
  const file = f as ProjectFile
  // Backfill id/name for older files that predate them.
  if (typeof file.id !== 'string' || !file.id) file.id = crypto.randomUUID()
  if (typeof file.name !== 'string' || !file.name) file.name = 'Untitled'
  return file
}

/** Read a project from a File — accepts a raw .json or an export .zip. */
export async function readProjectFromFile(file: File): Promise<ProjectFile> {
  const buf = new Uint8Array(await file.arrayBuffer())
  // Zip files start with "PK\x03\x04".
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const entries = unzipSync(buf)
    const found = entries['project.json'] ?? Object.entries(entries).find(([n]) => n.endsWith('project.json'))?.[1]
    if (!found) throw new Error('no project.json inside the zip')
    return parseProjectFile(strFromU8(found))
  }
  return parseProjectFile(strFromU8(buf))
}
