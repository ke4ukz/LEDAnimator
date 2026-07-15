import type { ProjectFile } from './projectFile'
import { parseProjectFile } from './projectFile'
import { listLibrary, saveProjectToLibrary } from './library'

// Back up / restore the whole project library as one JSON file. A backup is a
// simple container wrapping every saved ProjectFile; restore loads them all back
// in as new library entries (see `restoreProjects`).

const BACKUP_FORMAT = 'led-animator-backup'

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  /** When the backup was made (ms epoch) — informational. */
  exportedAt: number
  projects: ProjectFile[]
}

/** Bundle every saved project into one backup container (pretty JSON). */
export async function buildBackup(): Promise<{ json: string; count: number }> {
  const entries = await listLibrary()
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: Date.now(),
    projects: entries.map((e) => e.file),
  }
  return { json: JSON.stringify(backup, null, 2), count: entries.length }
}

/** Parse a backup file into its projects. Also accepts a single bare project
 *  file (treated as a one-project backup), so Restore is forgiving. Throws on
 *  anything else. */
export function parseBackup(text: string): ProjectFile[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('not valid JSON')
  }
  const d = data as Partial<BackupFile>
  if (d?.format === BACKUP_FORMAT) {
    if (!Array.isArray(d.projects)) throw new Error('backup file has no projects')
    // Validate + backfill each project (parseProjectFile re-checks the shape).
    return d.projects.map((p) => parseProjectFile(JSON.stringify(p)))
  }
  // Not a backup container — maybe it's a single exported project.
  return [parseProjectFile(text)]
}

/** Import projects into the library as NEW entries (fresh ids, never
 *  overwriting existing ones). Name collisions — against what's already saved
 *  and within this batch — are resolved by appending `-2`, `-3`, … Returns the
 *  number imported. */
export async function restoreProjects(projects: ProjectFile[]): Promise<number> {
  const existing = await listLibrary()
  const taken = new Set(existing.map((e) => e.name))
  for (const p of projects) {
    const name = uniqueName(p.name || 'Untitled', taken)
    taken.add(name)
    await saveProjectToLibrary({ ...p, id: crypto.randomUUID(), name })
  }
  return projects.length
}

/** `base` if free, else `base-2`, `base-3`, … until one isn't taken. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
