import type { ProjectFile } from './projectFile'

// A local library of saved projects, kept in IndexedDB (not localStorage):
// larger quota, stores objects directly, async. localStorage still holds the
// single "last open" project for an instant, synchronous startup.

export interface LibraryEntry {
  id: string
  name: string
  updatedAt: number
  file: ProjectFile
}

const DB_NAME = 'led-animator'
const STORE = 'projects'

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = op(d.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Insert or update a project (keyed by its id). */
export async function saveProjectToLibrary(file: ProjectFile): Promise<void> {
  const entry: LibraryEntry = { id: file.id, name: file.name, updatedAt: Date.now(), file }
  await run('readwrite', (s) => s.put(entry))
}

/** All saved projects, most-recently-updated first. */
export async function listLibrary(): Promise<LibraryEntry[]> {
  const all = await run('readonly', (s) => s.getAll() as IDBRequest<LibraryEntry[]>)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadProjectFromLibrary(id: string): Promise<ProjectFile | null> {
  const entry = await run('readonly', (s) => s.get(id) as IDBRequest<LibraryEntry | undefined>)
  return entry?.file ?? null
}

export async function deleteProjectFromLibrary(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id))
}
