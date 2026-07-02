import type { ProjectFile } from './export/projectFile'
import { parseProjectFile, serializeProjectFile } from './export/projectFile'

// Autosave the editable project to localStorage so work survives a reload.
// Only the ProjectFile (leds/sources/tracks/assignments/timing/display) is
// stored — the raster is derived and re-baked on load.

const KEY = 'led-animator:project'

export function loadSavedProjectFile(): ProjectFile | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parseProjectFile(raw) : null
  } catch {
    return null // missing, corrupt, or incompatible → fall back to default
  }
}

export function saveProjectFile(file: ProjectFile) {
  try {
    localStorage.setItem(KEY, serializeProjectFile(file))
  } catch {
    // storage unavailable or over quota — ignore
  }
}

export function clearSavedProject() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
