import { useState } from 'react'
import { useStore } from '../store'
import { ARRANGEMENTS, defaultParams } from '../arrangements'

/** Generate LED positions from a parametric shape preset. */
export function ArrangementPanel() {
  const addLeds = useStore((s) => s.addLeds)
  const ledCount = useStore((s) => s.leds.length)
  const [idx, setIdx] = useState(0)
  const preset = ARRANGEMENTS[idx]
  const [params, setParams] = useState<Record<string, number>>(() => defaultParams(preset))

  const choose = (i: number) => {
    setIdx(i)
    setParams(defaultParams(ARRANGEMENTS[i]))
  }

  const built = preset.build(params)

  return (
    <div className="arrange">
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

      <div className="arrange-actions">
        <span className="muted">+{built.length} LEDs</span>
        <button className="btn btn-primary" onClick={() => addLeds(built)}>Add shape</button>
      </div>
      <p className="placeholder">Adds this shape to the arrangement. Now: {ledCount} LEDs.</p>
    </div>
  )
}
