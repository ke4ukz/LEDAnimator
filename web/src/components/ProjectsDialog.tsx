import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { listLibrary, deleteProjectFromLibrary, type LibraryEntry } from '../export/library'

const fmtDate = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

/** Open / manage saved projects (the IndexedDB library). */
export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const loadProject = useStore((s) => s.loadProject)
  const blankSlate = useStore((s) => s.blankSlate)
  const currentId = useStore((s) => s.projectId)

  const refresh = () => listLibrary().then(setEntries)

  useEffect(() => {
    refresh() // list saved projects; the current one only shows if it's been Saved
  }, [])

  const open = (entry: LibraryEntry) => {
    const s = useStore.getState()
    // Re-opening the already-open project with no edits is a no-op. With edits,
    // reloading reverts to the saved version (after confirming the discard).
    if (entry.id === currentId && !s.dirty) return onClose()
    if (s.dirty && !window.confirm(`Discard unsaved changes to “${s.projectName || 'Untitled'}”?`)) return
    loadProject(entry.file)
    onClose()
  }

  const remove = async (entry: LibraryEntry) => {
    if (!window.confirm(`Delete “${entry.name}”? This can't be undone.`)) return
    await deleteProjectFromLibrary(entry.id)
    // Deleting the open project drops you to an unsaved blank slate.
    if (entry.id === currentId) blankSlate()
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
