import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ARRANGEMENTS, defaultParams } from '../arrangements'

/**
 * Generate LED positions from a shape preset. A floating card (no dimming
 * backdrop) so the ghost preview stays visible in the viewport — adjust, then
 * Add or Cancel. The ghost is cleared when the dialog closes (unmounts).
 */
export function ArrangementDialog({ onClose }: { onClose: () => void }) {
  const addLeds = useStore((s) => s.addLeds)
  const setGhost = useStore((s) => s.setGhost)
  const [idx, setIdx] = useState(0)
  const preset = ARRANGEMENTS[idx]
  const [params, setParams] = useState<Record<string, number>>(() => defaultParams(preset))
  const [device, setDevice] = useState(0)

  const built = preset.build(params)

  // Ghost preview follows the current shape/params; cleared on close (unmount).
  useEffect(() => {
    setGhost(preset.build(params))
  }, [preset, params, setGhost])
  useEffect(() => () => setGhost(null), [setGhost])

  // Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = (i: number) => {
    setIdx(i)
    setParams(defaultParams(ARRANGEMENTS[i]))
  }
  const add = () => {
    const built = preset.build(params)
    // Tag the new LEDs with the chosen device (omit when 0 = default single device).
    addLeds(device > 0 ? built.map((p) => ({ ...p, device })) : built)
    onClose()
  }

  return (
    <div className="arrange-dialog">
      <div className="modal-head">
        <h2>Add shape</h2>
        <button className="x" onClick={onClose} title="Close">×</button>
      </div>

      <label className="field-row">
        <span>Shape</span>
        <select value={idx} onChange={(e) => choose(Number(e.target.value))}>
          {ARRANGEMENTS.map((a, i) => (
            <option key={a.name} value={i}>{a.name}</option>
          ))}
        </select>
      </label>

      {preset.params.map((p) => (
        <label key={p.key} className="field-row">
          <span>{p.label}</span>
          <input
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            value={params[p.key]}
            onChange={(e) => setParams((s) => ({ ...s, [p.key]: Number(e.target.value) }))}
          />
          <span className="muted num">{params[p.key]}</span>
        </label>
      ))}

      <label className="field-row">
        <span title="Assign the new LEDs to this device (render slice). 0 = default single device.">Device</span>
        <input
          type="number"
          min={0}
          value={device}
          onChange={(e) => setDevice(Math.max(0, parseInt(e.target.value, 10) || 0))}
        />
      </label>

      <p className="muted arrange-hint">Preview shown in the viewport.</p>
      <div className="arrange-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={add}>Add {built.length} LEDs</button>
      </div>
    </div>
  )
}
