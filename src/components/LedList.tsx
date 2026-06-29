import { useStore } from '../store'
import { sampleRaster } from '../types'

/** LED list: per-row current-color swatch, click to select, dropdown to assign,
 *  and add/delete (multi-select aware). */
export function LedList() {
  const leds = useStore((s) => s.leds)
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selection = useStore((s) => s.selection)
  const selectLed = useStore((s) => s.selectLed)
  const assignLed = useStore((s) => s.assignLed)
  const addLeds = useStore((s) => s.addLeds)
  const deleteLeds = useStore((s) => s.deleteLeds)
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)
  const f = Math.min(frame, raster.numFrames - 1)

  return (
    <div className="led-list">
      <div className="led-list-head muted">{leds.length} LEDs · Shift-click for multiple</div>
      <ul>
        {leds.map((p, i) => {
          const [r, g, b] = sampleRaster(raster, f, i)
          return (
            <li
              key={i}
              className={selection.includes(i) ? 'sel' : ''}
              onClick={(e) => selectLed(i, e.shiftKey || e.metaKey || e.ctrlKey)}
            >
              <span className="swatch" style={{ background: `rgb(${r},${g},${b})` }} />
              <span className="idx">#{i}</span>
              <span className="muted">{p.x.toFixed(1)}, {p.y.toFixed(1)}, {p.z.toFixed(1)}</span>
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
