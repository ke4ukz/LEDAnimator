import type { ProjectFile } from './export/projectFile'
import { parseProjectFile, serializeProjectFile } from './export/projectFile'

// Recovery of the current working session (survives reload / crash). This is
// NOT the saved library — it never overwrites a saved project. The library
// (IndexedDB) only changes on an explicit Save. We also remember whether the
// working session had unsaved changes so the dirty state survives a reload.

const KEY = 'led-animator:project'
const DIRTY_KEY = 'led-animator:dirty'

export function loadSavedProjectFile(): ProjectFile | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parseProjectFile(raw) : null
  } catch {
    return null // missing, corrupt, or incompatible → fall back to default
  }
}

export function loadSavedDirty(): boolean {
  try {
    return localStorage.getItem(DIRTY_KEY) === '1'
  } catch {
    return false
  }
}

export function saveProjectFile(file: ProjectFile, dirty: boolean) {
  try {
    localStorage.setItem(KEY, serializeProjectFile(file))
    localStorage.setItem(DIRTY_KEY, dirty ? '1' : '0')
  } catch {
    // storage unavailable or over quota — ignore
  }
}

export function clearSavedProject() {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(DIRTY_KEY)
  } catch {
    // ignore
  }
}
