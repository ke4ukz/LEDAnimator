import { useStore } from '../store'
import { sampleRaster } from '../types'
import { rgbToHex } from '../color'

/** LED properties: editable position + track assignment for the selection. */
export function Inspector() {
  const selection = useStore((s) => s.selection)
  const leds = useStore((s) => s.leds)
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const project = useStore((s) => s.project)
  const updateLeds = useStore((s) => s.updateLeds)
  const assignLeds = useStore((s) => s.assignLeds)

  const sel = selection.filter((i) => leds[i])
  if (sel.length === 0) {
    return <p className="placeholder">Select one or more LEDs.</p>
  }

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
      <AxisField label="X" value={axis('x')} onChange={(v) => setAxis('x', v)} />
      <AxisField label="Y" value={axis('y')} onChange={(v) => setAxis('y', v)} />
      <AxisField label="Z" value={axis('z')} onChange={(v) => setAxis('z', v)} />
      <div className="insp-row">
        <span className="muted">Track</span>
        <select value={commonTrack} onChange={(e) => assignLeds(sel, e.target.value)}>
          {commonTrack === '' && <option value="" disabled>mixed</option>}
          {project.tracks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
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
