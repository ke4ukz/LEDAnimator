import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ARRANGEMENTS, defaultParams } from '../arrangements'

/** Generate LED positions from a shape preset, with a ghost-preview confirm step. */
export function ArrangementPanel() {
  const addLeds = useStore((s) => s.addLeds)
  const setGhost = useStore((s) => s.setGhost)
  const [idx, setIdx] = useState(0)
  const preset = ARRANGEMENTS[idx]
  const [params, setParams] = useState<Record<string, number>>(() => defaultParams(preset))
  const [pending, setPending] = useState(false)

  const built = preset.build(params)

  // While previewing, keep the ghost in sync with the params.
  useEffect(() => {
    setGhost(pending ? ARRANGEMENTS[idx].build(params) : null)
  }, [pending, idx, params, setGhost])
  // Clear the ghost if the panel unmounts.
  useEffect(() => () => setGhost(null), [setGhost])

  const choose = (i: number) => {
    setIdx(i)
    setParams(defaultParams(ARRANGEMENTS[i]))
  }

  const confirm = () => {
    addLeds(preset.build(params))
    setPending(false)
  }

  const summary = `${built.length} LEDs in a ${preset.name.toLowerCase()}`

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

      {pending ? (
        <>
          <div className="arrange-actions">
            <button className="btn" onClick={() => setPending(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirm}>Confirm</button>
          </div>
          <p className="placeholder">Preview shown — confirm to add {summary}.</p>
        </>
      ) : (
        <>
          <button className="btn btn-primary add-shape" onClick={() => setPending(true)}>Add shape</button>
          <p className="placeholder">Adds {summary}.</p>
        </>
      )}
    </div>
  )
}
