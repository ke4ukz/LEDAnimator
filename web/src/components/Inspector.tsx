import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { sampleRaster } from '../types'
import { rgbToHex } from '../color'
import { InfoDot } from './InfoDot'

/** LED properties: editable position + track assignment for the selection. */
export function Inspector() {
  const selection = useStore((s) => s.selection)
  const leds = useStore((s) => s.leds)
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const project = useStore((s) => s.project)
  const updateLeds = useStore((s) => s.updateLeds)
  const offsetLeds = useStore((s) => s.offsetLeds)
  const assignLeds = useStore((s) => s.assignLeds)
  const setLedDisabled = useStore((s) => s.setLedDisabled)
  const setLedUnassigned = useStore((s) => s.setLedUnassigned)
  const setLedAnimIndex = useStore((s) => s.setLedAnimIndex)
  const setLedDevice = useStore((s) => s.setLedDevice)

  // Relative mode: X/Y/Z inputs add a delta to each selected LED instead of
  // setting them all to one value. Remembered across sessions.
  const [relative, setRelative] = useState(() => localStorage.getItem('leda.inspector.relative') === '1')
  useEffect(() => { localStorage.setItem('leda.inspector.relative', relative ? '1' : '0') }, [relative])

  const sel = selection.filter((i) => leds[i])
  if (sel.length === 0) {
    return <p className="placeholder">Select one or more LEDs.</p>
  }

  const allUnassigned = sel.every((i) => leds[i].unassigned)
  const allDisabled = sel.every((i) => leds[i].disabled)
  const a0 = leds[sel[0]].animIndex
  const commonAnim = sel.every((i) => leds[i].animIndex === a0) ? a0 : undefined
  const dev0 = leds[sel[0]].device ?? 0
  const commonDevice = sel.every((i) => (leds[i].device ?? 0) === dev0) ? dev0 : undefined

  // Common value for an axis, or null if the selection differs.
  const axis = (k: 'x' | 'y' | 'z'): number | null => {
    const v0 = leds[sel[0]][k]
    return sel.every((i) => leds[i][k] === v0) ? v0 : null
  }
  const setAxis = (k: 'x' | 'y' | 'z', v: number) => updateLeds(sel, { [k]: v })

  const t0 = project.assignments[sel[0]]
  const commonTrack = sel.every((i) => project.assignments[i] === t0) ? t0 : ''

  const single = sel.length === 1 ? sel[0] : null
  const color = single != null ? sampleRaster(raster, Math.min(frame, raster.numFrames - 1), single) : null

  return (
    <div className="inspector-body">
      <div className="insp-row">
        <span className="muted">Selected</span>
        <strong>{single != null ? `LED #${single}` : `${sel.length} LEDs`}</strong>
      </div>
      <label className="insp-row insp-check">
        <span className="muted">
          Relative move{' '}
          <InfoDot label="About relative move">
            Adds the entered amount to each selected LED's position (e.g. +50 on Z raises them all by 50),
            instead of setting them all to the same value. Handy for moving a whole device without
            flattening its spacing.
          </InfoDot>
        </span>
        <input type="checkbox" checked={relative} onChange={(e) => setRelative(e.target.checked)} />
      </label>
      {relative ? (
        <>
          <NudgeField label="X" onNudge={(d) => offsetLeds(sel, { x: d })} />
          <NudgeField label="Y" onNudge={(d) => offsetLeds(sel, { y: d })} />
          <NudgeField label="Z" onNudge={(d) => offsetLeds(sel, { z: d })} />
        </>
      ) : (
        <>
          <AxisField label="X" value={axis('x')} onChange={(v) => setAxis('x', v)} />
          <AxisField label="Y" value={axis('y')} onChange={(v) => setAxis('y', v)} />
          <AxisField label="Z" value={axis('z')} onChange={(v) => setAxis('z', v)} />
        </>
      )}
      <div className="insp-row">
        <span className="muted">Track</span>
        <select value={commonTrack} onChange={(e) => assignLeds(sel, e.target.value)}>
          {commonTrack === '' && <option value="" disabled>mixed</option>}
          {project.tracks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <label className="insp-row insp-check">
        <span className="muted">
          Enabled{' '}
          <InfoDot label="About Enabled">
            When on, this LED is part of the physical chain and the exported strip. Turn it off for a
            layout/reference LED that isn't wired — it's dropped from the export, and following LEDs shift
            up to close the gap.
          </InfoDot>
        </span>
        <input type="checkbox" checked={!allUnassigned} onChange={(e) => setLedUnassigned(sel, !e.target.checked)} />
      </label>
      <div className="insp-row">
        <span className="muted">
          Device{' '}
          <InfoDot label="About Device">
            Which physical device renders this LED in a multi-device install. LEDs sharing a device export
            together as that board's slice. 0 = default (single device).
          </InfoDot>
        </span>
        <input
          type="number"
          min={0}
          placeholder={commonDevice === undefined ? 'mixed' : '0'}
          disabled={allUnassigned}
          value={commonDevice ?? ''}
          onChange={(e) => setLedDevice(sel, e.target.value === '' ? 0 : Number(e.target.value))}
        />
      </div>
      <div className="insp-row">
        <span className="muted">
          Anim #{' '}
          <InfoDot label="About the animation index">
            Position in the animation sequence, separate from wiring order. LEDs sharing a number animate
            together (e.g. a whole column). Blank = default (follows wiring order).
          </InfoDot>
        </span>
        <input
          type="number"
          min={0}
          placeholder="auto"
          disabled={allUnassigned || allDisabled}
          value={commonAnim ?? ''}
          onChange={(e) => setLedAnimIndex(sel, e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>
      <label className="insp-row insp-check">
        <span className="muted">
          Off (not animated){' '}
          <InfoDot label="About Off">
            Forces this LED to black in the animation but keeps its slot in the chain, so the pattern
            doesn't shift. Use for dead or intentionally-dark pixels. (Different from Enabled, which drops
            the LED from the chain entirely.)
          </InfoDot>
        </span>
        <input type="checkbox" checked={allDisabled} disabled={allUnassigned} onChange={(e) => setLedDisabled(sel, e.target.checked)} />
      </label>
      {color && (
        <div className="insp-row">
          <span className="muted">Color @ {frame}</span>
          <span className="swatch-inline">
            <span className="swatch" style={{ background: rgbToHex(color) }} />
            {rgbToHex(color)}
          </span>
        </div>
      )}
    </div>
  )
}

/** Relative position input: type a delta (e.g. 50 or -10) and commit on
 *  Enter/blur to add it to every selected LED, then clear. Uncontrolled so a
 *  keystroke doesn't apply mid-type. */
function NudgeField({ label, onNudge }: { label: string; onNudge: (delta: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const commit = () => {
    const raw = ref.current?.value ?? ''
    const n = parseFloat(raw)
    if (raw !== '' && !Number.isNaN(n) && n !== 0) onNudge(n)
    if (ref.current) ref.current.value = ''
  }
  return (
    <div className="insp-row">
      <span className="muted">{label}</span>
      <input
        ref={ref}
        type="number"
        step={0.1}
        placeholder="+0"
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}

function AxisField({
  label, value, onChange,
}: {
  label: string
  value: number | null
  onChange: (v: number) => void
}) {
  return (
    <div className="insp-row">
      <span className="muted">{label}</span>
      <input
        type="number"
        step={0.1}
        placeholder="mixed"
        value={value != null ? Number(value.toFixed(3)) : ''}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
      />
    </div>
  )
}
