import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { sampleRaster } from '../types'

/** Live current-color swatch for one LED. Isolated so the whole list doesn't
 *  re-render every frame. */
function LedSwatch({ index }: { index: number }) {
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const f = Math.min(frame, raster.numFrames - 1)
  const [r, g, b] = sampleRaster(raster, f, index)
  return <span className="swatch" style={{ background: `rgb(${r},${g},${b})` }} />
}

/** Editable order number: type a new index (Enter / blur) to move this LED
 *  there. Uncontrolled + commits from the ref so frame re-renders can't clobber
 *  the typed value. */
function OrderInput({ index, max, onCommit }: { index: number; max: number; onCommit: (n: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el) el.value = String(index)
  }, [index])
  const commit = () => {
    const n = parseInt(ref.current?.value ?? '', 10)
    if (!Number.isNaN(n) && n !== index) onCommit(n)
    if (ref.current) ref.current.value = String(index)
  }
  return (
    <input
      ref={ref}
      className="order"
      type="number"
      min={0}
      max={max}
      defaultValue={index}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}

/** LED list: live color swatch, click to select (Shift = range, Cmd/Ctrl =
 *  toggle), editable order number, track assignment, and add/delete. */
export function LedList() {
  const leds = useStore((s) => s.leds)
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selection = useStore((s) => s.selection)
  const selectLed = useStore((s) => s.selectLed)
  const assignLed = useStore((s) => s.assignLed)
  const addLeds = useStore((s) => s.addLeds)
  const deleteLeds = useStore((s) => s.deleteLeds)
  const moveLedTo = useStore((s) => s.moveLedTo)

  return (
    <div className="led-list">
      <div className="led-list-head muted">{leds.length} LEDs · Shift = range, ⌘/Ctrl = toggle</div>
      <ul>
        {leds.map((_, i) => (
          <li
            key={i}
            className={selection.includes(i) ? 'sel' : ''}
            onClick={(e) =>
              selectLed(i, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')
            }
          >
            <LedSwatch index={i} />
            <span className="hash muted">#</span>
            <OrderInput index={i} max={leds.length - 1} onCommit={(n) => moveLedTo(i, n)} />
            <select
              className="led-track"
              value={assignments[i]}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => assignLed(i, e.target.value)}
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <div className="led-list-actions">
        <button className="btn" onClick={() => addLeds([{ x: 0, y: 0, z: 0 }])}>+ Add LED</button>
        <button className="btn" disabled={selection.length === 0} onClick={() => deleteLeds(selection)}>
          Delete{selection.length > 1 ? ` (${selection.length})` : ''}
        </button>
      </div>
    </div>
  )
}
