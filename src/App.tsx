import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { buildTime, commit } from 'virtual:build-info'
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
import { readProjectFromFile } from './export/projectFile'
import { useStore } from './store'
import { usePlayer } from './usePlayer'
import './App.css'

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const BUILD = `${commit} · ${new Date(buildTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`

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
  const [dragging, setDragging] = useState(false)
  const loadProject = useStore((s) => s.loadProject)
  const fileRef = useRef<HTMLInputElement>(null)

  const importFile = useCallback(
    async (file?: File | null) => {
      if (!file) return
      if (!window.confirm('Import will replace the current project. Continue?')) return
      try {
        loadProject(await readProjectFromFile(file))
      } catch (err) {
        window.alert(`Could not import project: ${(err as Error).message}`)
      }
    },
    [loadProject],
  )

  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    importFile(file)
  }

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
        gridTemplateRows: `44px 1fr ${timelineH}px`,
      }}
    >
      <header className="topbar">
        <span className="brand">LED Animator</span>
        <span className="muted">in-browser editor · fixed-rate raster</span>
        <button className="btn export-btn" onClick={() => fileRef.current?.click()}>Import</button>
        <button className="btn" onClick={() => setExportOpen(true)}>Export</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={{ display: 'none' }}
          onChange={onImport}
        />
        <span className="build" title="loaded build (commit · build time)">build {BUILD}</span>
      </header>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
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

      <footer className="timeline">
        <Transport />
        <Timeline />
      </footer>

      <Splitter className="v" style={{ left: sidebarW - 3, top: 44, bottom: timelineH }}
        onDrag={(x) => setSidebarW(clamp(x - rect().left, 180, 460))} />
      <Splitter className="v" style={{ right: inspectorW - 3, top: 44, bottom: timelineH }}
        onDrag={(x) => setInspectorW(clamp(rect().right - x, 200, 540))} />
      <Splitter className="h" style={{ left: 0, right: 0, bottom: timelineH - 3 }}
        onDrag={(_x, y) => setTimelineH(clamp(rect().bottom - y, 130, 480))} />
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
