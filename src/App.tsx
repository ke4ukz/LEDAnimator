import type { ReactNode } from 'react'
import { Viewport } from './components/Viewport'
import { Transport } from './components/Transport'
import { GradientEditor } from './components/GradientEditor'
import { TrackPanel } from './components/TrackPanel'
import { TrackInspector } from './components/TrackInspector'
import { LedList } from './components/LedList'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { usePlayer } from './usePlayer'
import './App.css'

/**
 * App shell: a DAW-style layout — assets/arrangement on the left, the 3D
 * simulation in the center, an inspector on the right, and the timeline across
 * the bottom. Panels beyond the viewport are placeholders for now.
 */
export default function App() {
  usePlayer()

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">LED Animator</span>
        <span className="muted">in-browser editor · fixed-rate raster</span>
      </header>

      <aside className="sidebar">
        <Panel title="Tracks">
          <TrackPanel />
        </Panel>
        <Panel title="Source · Gradient">
          <GradientEditor />
        </Panel>
      </aside>

      <main className="viewport">
        <Viewport />
      </main>

      <aside className="inspector">
        <Panel title="Track">
          <TrackInspector />
        </Panel>
        <Panel title="LEDs">
          <LedList />
        </Panel>
        <Panel title="Selected LED">
          <Inspector />
        </Panel>
      </aside>

      <footer className="timeline">
        <Transport />
        <Timeline />
      </footer>
    </div>
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
