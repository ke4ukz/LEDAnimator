import { useEffect, useState } from 'react'
import { useStore } from '../store'

type Range = { from: string; to: string }

/**
 * Select LEDs by one or more inclusive index ranges. Add rows to build a
 * multi-part selection (e.g. 0–50 and 100–200 at once). "Select" replaces the
 * current selection with the union of the ranges; "Add" unions onto it.
 */
export function RangeSelectDialog({ onClose }: { onClose: () => void }) {
  const leds = useStore((s) => s.leds)
  const selection = useStore((s) => s.selection)
  const setSelection = useStore((s) => s.setSelection)
  const maxIdx = Math.max(0, leds.length - 1)
  const [ranges, setRanges] = useState<Range[]>([{ from: '0', to: String(maxIdx) }])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setRow = (i: number, patch: Partial<Range>) =>
    setRanges((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => setRanges((rs) => [...rs, { from: '', to: '' }])
  const removeRow = (i: number) => setRanges((rs) => (rs.length === 1 ? rs : rs.filter((_, j) => j !== i)))

  // Union of every valid range, clamped to the chain.
  const indices = () => {
    const set = new Set<number>()
    for (const r of ranges) {
      const a = parseInt(r.from, 10)
      const b = parseInt(r.to, 10)
      if (Number.isNaN(a) || Number.isNaN(b)) continue
      const lo = Math.max(0, Math.min(a, b))
      const hi = Math.min(maxIdx, Math.max(a, b))
      for (let i = lo; i <= hi; i++) set.add(i)
    }
    return [...set]
  }
  const count = indices().length

  const apply = (additive: boolean) => {
    const idxs = indices()
    setSelection(additive ? [...new Set([...selection, ...idxs])] : idxs)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal range-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Select range</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        <p className="muted">Select LEDs by index range. Add rows for a multi-part selection.</p>

        <div className="range-rows">
          {ranges.map((r, i) => (
            <div className="range-row" key={i}>
              <input
                type="number"
                min={0}
                max={maxIdx}
                placeholder="from"
                value={r.from}
                onChange={(e) => setRow(i, { from: e.target.value })}
              />
              <span className="muted">to</span>
              <input
                type="number"
                min={0}
                max={maxIdx}
                placeholder="to"
                value={r.to}
                onChange={(e) => setRow(i, { to: e.target.value })}
              />
              <button
                className="range-x"
                title="Remove this range"
                disabled={ranges.length === 1}
                onClick={() => removeRow(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button className="btn range-add" onClick={addRow}>+ Add range</button>

        <div className="export-actions">
          <button className="btn btn-primary" disabled={count === 0} onClick={() => apply(false)}>
            Select {count} LED{count === 1 ? '' : 's'}
          </button>
          <button className="btn" disabled={count === 0} onClick={() => apply(true)} title="Add these ranges to the current selection">
            Add to selection
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
