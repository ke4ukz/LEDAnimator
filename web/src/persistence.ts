import type { ProjectFile } from './export/projectFile'
import { parseProjectFile, serializeProjectFile } from './export/projectFile'

// Recovery of the current working session (survives reload / crash). This is
// NOT the saved library — it never overwrites a saved project. The library
// (IndexedDB) only changes on an explicit Save. We also remember whether the
// working session had unsaved changes so the dirty state survives a reload.

const KEY = 'led-animator:project'
const DIRTY_KEY = 'led-animator:dirty'
// The library name this project is saved under (absent = never saved to the
// library). Lets the rename-Save overwrite check survive a reload without
// falsely warning for a recovered-but-never-saved project.
const SAVED_NAME_KEY = 'led-animator:savedName'

// Bump this whenever a change could make a stale auto-recovered session bleed
// through confusingly (e.g. leftover Adjustments applied to a newly-loaded
// source). On mismatch the working-session recovery is cleared so we start from
// a clean slate. The saved library (explicit Saves, in IndexedDB) is untouched.
const STORAGE_VERSION = '2'
const VERSION_KEY = 'led-animator:storageVersion'

/** Clear the auto-recovered working session when the storage version changed,
 *  so old experimental tweaks don't carry into a new build. Call before loading
 *  the recovery. Returns true if it wiped. */
export function enforceStorageVersion(): boolean {
  try {
    if (localStorage.getItem(VERSION_KEY) === STORAGE_VERSION) return false
    localStorage.removeItem(KEY)
    localStorage.removeItem(DIRTY_KEY)
    localStorage.removeItem(SAVED_NAME_KEY)
    localStorage.setItem(VERSION_KEY, STORAGE_VERSION)
    return true
  } catch {
    return false // storage unavailable — nothing to clear
  }
}

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

/** The library name the recovered project was saved under, or null if it was
 *  never saved to the library. */
export function loadSavedName(): string | null {
  try {
    return localStorage.getItem(SAVED_NAME_KEY)
  } catch {
    return null
  }
}

export function saveProjectFile(file: ProjectFile, dirty: boolean, savedName: string | null) {
  try {
    localStorage.setItem(KEY, serializeProjectFile(file))
    localStorage.setItem(DIRTY_KEY, dirty ? '1' : '0')
    if (savedName == null) localStorage.removeItem(SAVED_NAME_KEY)
    else localStorage.setItem(SAVED_NAME_KEY, savedName)
  } catch {
    // storage unavailable or over quota — ignore
  }
}

export function clearSavedProject() {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(DIRTY_KEY)
    localStorage.removeItem(SAVED_NAME_KEY)
  } catch {
    // ignore
  }
}
