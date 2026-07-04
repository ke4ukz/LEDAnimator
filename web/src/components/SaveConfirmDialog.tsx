import { useEffect } from 'react'

/**
 * Shown when Save would overwrite the saved library entry under a *different*
 * name (i.e. the project was renamed in place). Lets the user overwrite the
 * existing project, branch their work off as a new one, or cancel.
 */
export function SaveConfirmDialog({
  savedName,
  newName,
  onOverwrite,
  onSaveAs,
  onCancel,
}: {
  savedName: string
  newName: string
  onOverwrite: () => void
  onSaveAs: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Save changes?</h2>
          <button className="x" onClick={onCancel} title="Close">×</button>
        </div>
        <p className="confirm-text">
          You renamed this project from “{savedName}” to “{newName}”. Overwrite the
          saved project, or keep it and save your work as a new one?
        </p>
        <div className="export-actions confirm-actions">
          <button className="btn btn-primary" onClick={onOverwrite}>Overwrite “{savedName}”</button>
          <button className="btn" onClick={onSaveAs}>Save as “{newName}”</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
