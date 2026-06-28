import { useStore } from '../store'

/** Scrollable list of every LED in the arrangement; click to select. */
export function LedList() {
  const leds = useStore((s) => s.leds)
  const selected = useStore((s) => s.selectedLed)
  const selectLed = useStore((s) => s.selectLed)

  return (
    <div className="led-list">
      <div className="led-list-head muted">{leds.length} LEDs · 1 track (all assigned)</div>
      <ul>
        {leds.map((p, i) => (
          <li
            key={i}
            className={i === selected ? 'sel' : ''}
            onClick={() => selectLed(i)}
          >
            <span className="idx">#{i}</span>
            <span className="muted">
              {p.x.toFixed(1)}, {p.y.toFixed(1)}, {p.z.toFixed(1)}
            </span>
            <span className="tag">Track 1</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
