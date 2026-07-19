import type { ReactNode } from 'react'
import { useStore } from '../store'
import { type Keyframe, type Track, newId } from '../project'

/** Edits the selected track's motion: name, speed, offset, chase. (The sampling
 *  path lives with the preview in the Source panel.) */
export function TrackInspector() {
  const project = useStore((s) => s.project)
  const selected = useStore((s) => s.selectedTrack)
  const updateTrack = useStore((s) => s.updateTrack)
  const setAutomation = useStore((s) => s.setAutomation)
  const assignments = useStore((s) => s.project.assignments)
  const leds = useStore((s) => s.leds)
  const addTrack = useStore((s) => s.addTrack)

  const track = project.tracks.find((t) => t.id === selected)
  if (!track) {
    // No tracks at all → an actionable CTA instead of a dead-end "select a track"
    // (a New project starts empty). With tracks present, prompt to pick one.
    return project.tracks.length === 0 ? (
      <div className="placeholder">No tracks yet. <button className="btn" onClick={addTrack}>+ Add a track</button></div>
    ) : (
      <p className="placeholder">Select a track to edit it.</p>
    )
  }

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

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input type="number" min={0} max={1} step={0.01} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </Row>
  )
}
