import { useStore } from '../store'

/**
 * View settings as a transparent toolbar floating across the top of the
 * viewport (size / shape / numbers / sample markers). These are how the scene
 * is displayed, not properties of the LEDs — so they live over the viewport
 * rather than in the LED panels.
 */
export function ViewportToolbar() {
  const ledScale = useStore((s) => s.ledScale)
  const ledShape = useStore((s) => s.ledShape)
  const labelMode = useStore((s) => s.labelMode)
  const showSamples = useStore((s) => s.showSamples)
  const setLedScale = useStore((s) => s.setLedScale)
  const setLedShape = useStore((s) => s.setLedShape)
  const setLabelMode = useStore((s) => s.setLabelMode)
  const setShowSamples = useStore((s) => s.setShowSamples)

  return (
    <div className="viewport-toolbar">
      <div className="vt-group">
        <span className="muted">Size</span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={ledScale}
          onChange={(e) => setLedScale(Number(e.target.value))}
        />
        <span className="muted num">{ledScale.toFixed(1)}×</span>
      </div>
      <div className="vt-group">
        <span className="muted">Shape</span>
        <select value={ledShape} onChange={(e) => setLedShape(e.target.value as 'sphere' | 'cube')}>
          <option value="sphere">Sphere</option>
          <option value="cube">Cube</option>
        </select>
      </div>
      <div className="vt-group">
        <span className="muted">Numbers</span>
        <select value={labelMode} onChange={(e) => setLabelMode(e.target.value as 'none' | 'chain' | 'anim')}>
          <option value="none">None</option>
          <option value="chain">LED index</option>
          <option value="anim">Animation index</option>
        </select>
      </div>
      <label className="vt-group">
        <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} />
        <span className="muted">Sample markers</span>
      </label>
    </div>
  )
}
