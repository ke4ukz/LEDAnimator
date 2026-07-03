import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { listLibrary, deleteProjectFromLibrary, saveProjectToLibrary, type LibraryEntry } from '../export/library'

const fmtDate = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

/** Open / manage saved projects (the IndexedDB library). */
export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const loadProject = useStore((s) => s.loadProject)
  const newProject = useStore((s) => s.newProject)
  const currentId = useStore((s) => s.projectId)

  const refresh = () => listLibrary().then(setEntries)

  useEffect(() => {
    // Make sure the current project is in the list and up to date before listing.
    saveProjectToLibrary(useStore.getState().getProjectFile()).then(refresh)
  }, [])

  const open = (entry: LibraryEntry) => {
    if (entry.id !== currentId) loadProject(entry.file)
    onClose()
  }

  const remove = async (entry: LibraryEntry) => {
    if (!window.confirm(`Delete “${entry.name}”? This can't be undone.`)) return
    if (entry.id === currentId) {
      // Switch away first (flushes+replaces current), then delete the old entry
      // so autosave can't resurrect it.
      newProject()
    }
    await deleteProjectFromLibrary(entry.id)
    refresh()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Projects</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        {entries === null ? (
          <div className="muted">Loading…</div>
        ) : entries.length === 0 ? (
          <p className="placeholder">No saved projects yet.</p>
        ) : (
          <ul className="project-list">
            {entries.map((entry) => (
              <li key={entry.id} className={entry.id === currentId ? 'current' : ''}>
                <button className="project-open" onClick={() => open(entry)}>
                  <span className="project-name-label">{entry.name || 'Untitled'}</span>
                  <span className="muted">{fmtDate(entry.updatedAt)}{entry.id === currentId ? ' · open' : ''}</span>
                </button>
                <button className="x" title="Delete" onClick={() => remove(entry)}>🗑</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
