import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Viewport } from './components/Viewport'
import { Transport } from './components/Transport'
import { GradientEditor } from './components/GradientEditor'
import { TrackPanel } from './components/TrackPanel'
import { TrackInspector } from './components/TrackInspector'
import { ArrangementPanel } from './components/ArrangementPanel'
import { DisplayPanel } from './components/DisplayPanel'
import { LedList } from './components/LedList'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { ExportDialog } from './components/ExportDialog'
import { AboutDialog } from './components/AboutDialog'
import { ProjectsDialog } from './components/ProjectsDialog'
import { SaveConfirmDialog } from './components/SaveConfirmDialog'
import { KebabMenu } from './components/KebabMenu'
import { readProjectFromFile } from './export/projectFile'
import { deleteProjectFromLibrary } from './export/library'
import { useStore } from './store'
import { usePlayer } from './usePlayer'
import './App.css'

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const FOOTER_H = 26

/**
 * App shell: a DAW-style layout — tracks/source on the left, the 3D simulation
 * in the center, inspectors on the right, and the timeline across the bottom.
 * The side panels and timeline are resizable via splitter handles.
 */
export default function App() {
  usePlayer()
  const appRef = useRef<HTMLDivElement>(null)
  const [sidebarW, setSidebarW] = useState(250)
  const [inspectorW, setInspectorW] = useState(290)
  const [timelineH, setTimelineH] = useState(220)
  const [exportOpen, setExportOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [saveConfirm, setSaveConfirm] = useState<{ savedName: string; newName: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const loadProject = useStore((s) => s.loadProject)
  const newProject = useStore((s) => s.newProject)
  const blankSlate = useStore((s) => s.blankSlate)
  const projectName = useStore((s) => s.projectName)
  const renameProject = useStore((s) => s.renameProject)
  const dirty = useStore((s) => s.dirty)
  const saveProject = useStore((s) => s.saveProject)
  const saveProjectAs = useStore((s) => s.saveProjectAs)
  const fileRef = useRef<HTMLInputElement>(null)

  // Confirm before throwing away unsaved edits (no undo).
  const confirmDiscard = useCallback(() => {
    const s = useStore.getState()
    return !s.dirty || window.confirm(`Discard unsaved changes to “${s.projectName || 'Untitled'}”?`)
  }, [])

  const onNew = () => {
    if (confirmDiscard()) newProject()
  }

  // Save, but if the project was renamed in place (its edited name differs from
  // the name it's saved under), confirm overwrite vs. Save As first.
  const onSave = useCallback(() => {
    const s = useStore.getState()
    const name = s.projectName.trim()
    if (s.savedName !== null && name && name !== s.savedName) {
      setSaveConfirm({ savedName: s.savedName, newName: name })
    } else {
      saveProject()
    }
  }, [saveProject])

  const onSaveAs = () => {
    const name = window.prompt('Save as — project name:', useStore.getState().projectName || 'Untitled')
    if (name && name.trim()) saveProjectAs(name)
  }

  const onDelete = () => {
    if (!window.confirm(`Delete “${projectName || 'Untitled'}”? This can't be undone.`)) return
    const id = useStore.getState().projectId
    deleteProjectFromLibrary(id).then(() => blankSlate())
  }

  const importFile = useCallback(
    async (file?: File | null) => {
      if (!file) return
      if (!confirmDiscard()) return
      try {
        loadProject(await readProjectFromFile(file), { dirty: true })
      } catch (err) {
        window.alert(`Could not import project: ${(err as Error).message}`)
      }
    },
    [loadProject, confirmDiscard],
  )

  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    importFile(file)
  }

  // ⌘S / Ctrl-S saves the current project to the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])

  // Drag-and-drop a .json / .zip anywhere onto the window to import.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const onLeave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false) }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      importFile(e.dataTransfer?.files?.[0])
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [importFile])

  const rect = () => appRef.current!.getBoundingClientRect()

  return (
    <div
      ref={appRef}
      className="app"
      style={{
        gridTemplateColumns: `${sidebarW}px 1fr ${inspectorW}px`,
        gridTemplateRows: `44px 1fr ${timelineH}px ${FOOTER_H}px`,
      }}
    >
      <header className="topbar">
        <span className="brand">LED Animator</span>
        <label className="name-field" title="Project name (click to edit)">
          <svg className="name-pencil" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <input
            className="project-name"
            value={projectName}
            placeholder="Untitled"
            aria-label="Project name"
            onChange={(e) => renameProject(e.target.value)}
          />
        </label>
        {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
        <div className="topbar-spacer" />
        {dirty && (
          <button className="save-link" onClick={onSave}>Save</button>
        )}
        <button className="icon-btn" title="Export" aria-label="Export" onClick={() => setExportOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <KebabMenu
          items={[
            { label: 'New', onClick: onNew },
            { label: 'Open', onClick: () => setProjectsOpen(true) },
            { label: 'Save', onClick: onSave },
            { label: 'Save As', onClick: onSaveAs },
            { label: 'Import', onClick: () => fileRef.current?.click() },
            { label: 'Export', onClick: () => setExportOpen(true) },
            { label: 'Delete', onClick: onDelete, danger: true },
            { label: 'About', onClick: () => setAboutOpen(true) },
          ]}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={{ display: 'none' }}
          onChange={onImport}
        />
      </header>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {projectsOpen && <ProjectsDialog onClose={() => setProjectsOpen(false)} />}
      {saveConfirm && (
        <SaveConfirmDialog
          savedName={saveConfirm.savedName}
          newName={saveConfirm.newName}
          onOverwrite={() => { saveProject(); setSaveConfirm(null) }}
          onSaveAs={() => { saveProjectAs(saveConfirm.newName); setSaveConfirm(null) }}
          onCancel={() => setSaveConfirm(null)}
        />
      )}
      {dragging && <div className="drop-overlay">Drop a project (.json or .zip) to import</div>}

      <aside className="sidebar">
        <Panel title="Tracks">
          <TrackPanel />
        </Panel>
        <Panel title="Source · Gradient">
          <GradientEditor />
        </Panel>
        <Panel title="Track properties">
          <TrackInspector />
        </Panel>
      </aside>

      <main className="viewport">
        <Viewport />
      </main>

      <aside className="inspector">
        <Panel title="Arrangement">
          <ArrangementPanel />
        </Panel>
        <Panel title="Display">
          <DisplayPanel />
        </Panel>
        <Panel title="LEDs">
          <LedList />
        </Panel>
        <Panel title="LED properties">
          <Inspector />
        </Panel>
      </aside>

      <section className="timeline">
        <Transport />
        <Timeline />
      </section>

      <footer className="appfoot">
        <span>
          © 2026 Jonathan Dean ·{' '}
          <a href="https://github.com/ke4ukz/LEDAnimator/blob/HEAD/LICENSE" target="_blank" rel="noopener noreferrer">
            AGPL-3.0
          </a>
        </span>
        <nav className="foot-links">
          <a href="https://github.com/ke4ukz/LEDAnimator" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="https://github.com/ke4ukz/LEDAnimator/issues/new" target="_blank" rel="noopener noreferrer">Report an issue</a>
          <a href="../third-party-notices.txt" target="_blank" rel="noopener noreferrer">Licenses</a>
          <a href="../privacy/" target="_blank" rel="noopener noreferrer">Privacy</a>
        </nav>
      </footer>

      <Splitter className="v" style={{ left: sidebarW - 3, top: 44, bottom: timelineH + FOOTER_H }}
        onDrag={(x) => setSidebarW(clamp(x - rect().left, 180, 460))} />
      <Splitter className="v" style={{ right: inspectorW - 3, top: 44, bottom: timelineH + FOOTER_H }}
        onDrag={(x) => setInspectorW(clamp(rect().right - x, 200, 540))} />
      <Splitter className="h" style={{ left: 0, right: 0, bottom: timelineH + FOOTER_H - 3 }}
        onDrag={(_x, y) => setTimelineH(clamp(rect().bottom - y - FOOTER_H, 130, 480))} />
    </div>
  )
}

function Splitter({
  className, style, onDrag,
}: {
  className: string
  style: React.CSSProperties
  onDrag: (clientX: number, clientY: number) => void
}) {
  const active = useRef(false)
  return (
    <div
      className={`splitter ${className}`}
      style={style}
      onPointerDown={(e) => {
        active.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => active.current && onDrag(e.clientX, e.clientY)}
      onPointerUp={(e) => {
        active.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
    />
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      <div className="panel-body">{children}</div>
    </section>
  )
}
