import type { ReactNode } from 'react'
import { Viewport } from './components/Viewport'
import { Transport } from './components/Transport'
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
        <Panel title="Assets">
          <p className="placeholder">Upload color-track images here.</p>
        </Panel>
        <Panel title="Arrangement">
          <p className="placeholder">Place LEDs in 3D (presets + manual).</p>
        </Panel>
      </aside>

      <main className="viewport">
        <Viewport />
      </main>

      <aside className="inspector">
        <Panel title="Inspector">
          <p className="placeholder">Select a track or LED to edit its parameters.</p>
        </Panel>
      </aside>

      <footer className="timeline">
        <Transport />
        <div className="lanes placeholder">Track lanes &amp; speed-automation go here.</div>
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
