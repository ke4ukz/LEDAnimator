import { useStore } from '../store'

/** View settings for the LEDs: size, shape, and index labels. */
export function DisplayPanel() {
  const ledScale = useStore((s) => s.ledScale)
  const ledShape = useStore((s) => s.ledShape)
  const showLabels = useStore((s) => s.showLabels)
  const showSamples = useStore((s) => s.showSamples)
  const setLedScale = useStore((s) => s.setLedScale)
  const setLedShape = useStore((s) => s.setLedShape)
  const setShowLabels = useStore((s) => s.setShowLabels)
  const setShowSamples = useStore((s) => s.setShowSamples)

  return (
    <div className="display-panel">
      <label className="field-row">
        <span>Size</span>
        <input type="range" min={0.2} max={3} step={0.1} value={ledScale} onChange={(e) => setLedScale(Number(e.target.value))} />
        <span className="muted num">{ledScale.toFixed(1)}×</span>
      </label>
      <label className="field-row">
        <span>Shape</span>
        <select value={ledShape} onChange={(e) => setLedShape(e.target.value as 'sphere' | 'cube')}>
          <option value="sphere">Sphere</option>
          <option value="cube">Cube</option>
        </select>
      </label>
      <label className="field-row">
        <span>Numbers</span>
        <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
      </label>
      <label className="field-row" title="Ghost markers on the path preview showing where each LED samples right now">
        <span>Sample markers</span>
        <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} />
      </label>
    </div>
  )
}
