import { useStore } from '../store'

/** Scrollable list of every LED; click to select, dropdown to assign a track. */
export function LedList() {
  const leds = useStore((s) => s.leds)
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selection = useStore((s) => s.selection)
  const selectLed = useStore((s) => s.selectLed)
  const assignLed = useStore((s) => s.assignLed)

  return (
    <div className="led-list">
      <div className="led-list-head muted">{leds.length} LEDs · Shift-click for multiple</div>
      <ul>
        {leds.map((p, i) => (
          <li
            key={i}
            className={selection.includes(i) ? 'sel' : ''}
            onClick={(e) => selectLed(i, e.shiftKey || e.metaKey || e.ctrlKey)}
          >
            <span className="idx">#{i}</span>
            <span className="muted">
              {p.x.toFixed(1)}, {p.y.toFixed(1)}, {p.z.toFixed(1)}
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
        ))}
      </ul>
    </div>
  )
}
