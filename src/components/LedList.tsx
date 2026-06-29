import { useStore } from '../store'
import { sampleRaster } from '../types'

/** LED list: live color swatch, click to select (Shift = range, Cmd/Ctrl =
 *  toggle), reorder arrows, track assignment, and add/delete. */
export function LedList() {
  const leds = useStore((s) => s.leds)
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selection = useStore((s) => s.selection)
  const selectLed = useStore((s) => s.selectLed)
  const assignLed = useStore((s) => s.assignLed)
  const addLeds = useStore((s) => s.addLeds)
  const deleteLeds = useStore((s) => s.deleteLeds)
  const moveLed = useStore((s) => s.moveLed)
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const f = Math.min(frame, raster.numFrames - 1)

  return (
    <div className="led-list">
      <div className="led-list-head muted">{leds.length} LEDs · Shift = range, ⌘/Ctrl = toggle</div>
      <ul>
        {leds.map((_, i) => {
          const [r, g, b] = sampleRaster(raster, f, i)
          return (
            <li
              key={i}
              className={selection.includes(i) ? 'sel' : ''}
              onClick={(e) =>
                selectLed(i, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')
              }
            >
              <span className="swatch" style={{ background: `rgb(${r},${g},${b})` }} />
              <span className="idx">#{i}</span>
              <span className="reorder">
                <button className="x" title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveLed(i, -1) }}>▲</button>
                <button className="x" title="Move down" disabled={i === leds.length - 1} onClick={(e) => { e.stopPropagation(); moveLed(i, 1) }}>▼</button>
              </span>
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
          )
        })}
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
