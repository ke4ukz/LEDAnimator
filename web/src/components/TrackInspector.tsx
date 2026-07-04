import type { ReactNode } from 'react'
import { useStore } from '../store'
import { type Keyframe, type PathDef, type Track, newId } from '../project'

/** Edits the selected track: name, sampling path, speed, offset, chase. */
export function TrackInspector() {
  const project = useStore((s) => s.project)
  const selected = useStore((s) => s.selectedTrack)
  const updateTrack = useStore((s) => s.updateTrack)
  const setAutomation = useStore((s) => s.setAutomation)
  const assignments = useStore((s) => s.project.assignments)
  const leds = useStore((s) => s.leds)

  const track = project.tracks.find((t) => t.id === selected)
  if (!track) return <p className="placeholder">Select a track to edit it.</p>

  // "Even" spreads one full pass across the ANIMATION-index range, not the raw
  // LED count — so grouped LEDs (shared index) count once and gaps are honored.
  // = max effective animIndex + 1 over this track's in-chain (wired) members.
  const evenSteps = (() => {
    let rank = 0
    let max = -1
    assignments.forEach((id, i) => {
      if (id !== track.id || leds[i]?.unassigned) return
      const idx = leds[i]?.animIndex ?? rank
      if (idx > max) max = idx
      rank++
    })
    return max + 1
  })()
  const set = (patch: Partial<Track>) => updateTrack(track.id, patch)
  const setPath = (path: PathDef) => set({ path })

  const speedAnimated = !!track.automations?.speed
  const animateSpeed = () => {
    const keys: Keyframe[] = [
      { id: newId('kf'), t: 0, value: track.speed, ease: 'linear' },
      { id: newId('kf'), t: 1, value: track.speed, ease: 'linear' },
    ]
    setAutomation(track.id, 'speed', { keys, linkEnds: false })
  }
  const removeSpeedAuto = () => {
    const n = track.automations?.speed?.keys.length ?? 0
    if (!window.confirm(`Remove the speed animation (${n} keyframes)? This can't be undone.`)) return
    set({ speed: track.automations?.speed?.keys[0]?.value ?? track.speed })
    setAutomation(track.id, 'speed', null)
  }

  return (
    <div className="track-insp">
      <Row label="Name">
        <input className="text" value={track.name} onChange={(e) => set({ name: e.target.value })} />
      </Row>

      <Row label="Path">
        <select
          value={track.path.type}
          onChange={(e) => setPath(pathOfType(e.target.value as PathDef['type']))}
        >
          <option value="line">Line</option>
          <option value="sine">Sine</option>
          <option value="ellipse">Ellipse</option>
          <option value="spiral">Spiral</option>
          <option value="polygon">Polygon</option>
        </select>
        <button className="btn" title="Reset this path to its defaults" onClick={() => setPath(pathOfType(track.path.type))}>
          Reset
        </button>
      </Row>

      {track.path.type === 'line' && (
        <>
          <Num label="From X" value={track.path.x0} onChange={(x0) => setPath({ ...track.path, x0 } as PathDef)} />
          <Num label="From Y" value={track.path.y0} onChange={(y0) => setPath({ ...track.path, y0 } as PathDef)} />
          <Num label="To X" value={track.path.x1} onChange={(x1) => setPath({ ...track.path, x1 } as PathDef)} />
          <Num label="To Y" value={track.path.y1} onChange={(y1) => setPath({ ...track.path, y1 } as PathDef)} />
        </>
      )}
      {track.path.type === 'sine' && (
        <>
          <Num label="Mid Y" value={track.path.midV} onChange={(midV) => setPath({ ...track.path, midV } as PathDef)} />
          <Num label="Amplitude" value={track.path.amp} min={-1} max={1} onChange={(amp) => setPath({ ...track.path, amp } as PathDef)} />
          <Num label="Frequency" value={track.path.freq} min={0} max={8} step={0.25} onChange={(freq) => setPath({ ...track.path, freq } as PathDef)} />
          <Num label="Phase" value={track.path.phase} onChange={(phase) => setPath({ ...track.path, phase } as PathDef)} />
        </>
      )}
      {track.path.type === 'ellipse' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Radius X" value={track.path.rx} onChange={(rx) => setPath({ ...track.path, rx } as PathDef)} />
          <Num label="Radius Y" value={track.path.ry} onChange={(ry) => setPath({ ...track.path, ry } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}
      {track.path.type === 'spiral' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Inner radius" value={track.path.r0} onChange={(r0) => setPath({ ...track.path, r0 } as PathDef)} />
          <Num label="Outer radius" value={track.path.r1} onChange={(r1) => setPath({ ...track.path, r1 } as PathDef)} />
          <Num label="Turns" value={track.path.turns} min={0.25} max={12} step={0.25} onChange={(turns) => setPath({ ...track.path, turns } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}
      {track.path.type === 'polygon' && (
        <>
          <Num label="Center X" value={track.path.cx} onChange={(cx) => setPath({ ...track.path, cx } as PathDef)} />
          <Num label="Center Y" value={track.path.cy} onChange={(cy) => setPath({ ...track.path, cy } as PathDef)} />
          <Num label="Size" value={track.path.size} onChange={(size) => setPath({ ...track.path, size } as PathDef)} />
          <Num label="Sides" value={track.path.sides} min={3} max={12} step={1} onChange={(sides) => setPath({ ...track.path, sides: Math.round(sides) } as PathDef)} />
          <Num label="Angle°" value={track.path.rot ?? 0} min={-360} max={360} step={5} onChange={(rot) => setPath({ ...track.path, rot } as PathDef)} />
        </>
      )}

      <hr className="sep" />

      <Row label="Speed">
        {speedAnimated ? (
          <>
            <span className="muted">animated · timeline</span>
            <button className="btn" onClick={removeSpeedAuto}>Remove</button>
          </>
        ) : (
          <>
            <input
              type="number"
              min={-4}
              max={4}
              step={0.1}
              value={Number(track.speed.toFixed(3))}
              onChange={(e) => set({ speed: Number(e.target.value) })}
            />
            <button className="btn" onClick={animateSpeed}>Animate</button>
          </>
        )}
      </Row>
      <Num label="Offset" value={track.offset} onChange={(offset) => set({ offset })} />
      <Row label="Chase">
        <input
          type="number"
          min={-1}
          max={1}
          step={0.01}
          value={Number(track.chase.toFixed(3))}
          onChange={(e) => set({ chase: Number(e.target.value) })}
        />
        <button
          className="btn"
          title="Spread one full pass across this track's animation positions"
          onClick={() => set({ chase: evenSteps > 0 ? 1 / evenSteps : 0 })}
        >
          Even
        </button>
      </Row>
    </div>
  )
}

function pathOfType(type: PathDef['type']): PathDef {
  switch (type) {
    case 'line': return { type, x0: 0, y0: 0.5, x1: 1, y1: 0.5 }
    case 'sine': return { type, midV: 0.5, amp: 0.4, freq: 1, phase: 0 }
    case 'ellipse': return { type, cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.4, rot: 0 }
    case 'spiral': return { type, cx: 0.5, cy: 0.5, r0: 0.05, r1: 0.45, turns: 3, rot: 0 }
    case 'polygon': return { type, cx: 0.5, cy: 0.5, size: 0.4, sides: 3, rot: 0 }
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  // A div, not a label: a <label> wrapping a button activates that button when
  // its text is clicked, which can wipe data (e.g. Remove animation).
  return (
    <div className="field-row">
      <span>{label}</span>
      {children}
    </div>
  )
}

function Num({
  label, value, onChange, min = 0, max = 1, step = 0.01,
}: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <Row label={label}>
      <input type="number" min={min} max={max} step={step} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  )
}
