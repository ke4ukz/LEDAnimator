import { type ReactNode, useRef, useState } from 'react'
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
        <button className="btn export-btn" onClick={() => setExportOpen(true)}>Export</button>
        <span className="build" title="loaded build (commit · build time)">build {BUILD}</span>
      </header>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}

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
