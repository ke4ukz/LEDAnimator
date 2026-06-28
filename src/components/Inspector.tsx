import { useStore } from '../store'
import { sampleRaster } from '../types'
import { rgbToHex } from '../color'

/** Shows details for the selected LED (read-only for now). */
export function Inspector() {
  const sel = useStore((s) => s.selectedLed)
  const leds = useStore((s) => s.leds)
  const raster = useStore((s) => s.raster)
  const frame = useStore((s) => s.frame)

  if (sel == null || !leds[sel]) {
    return <p className="placeholder">Select an LED in the list to inspect it.</p>
  }

  const p = leds[sel]
  const color = sampleRaster(raster, Math.min(frame, raster.numFrames - 1), sel)

  return (
    <div className="inspector-body">
      <div className="insp-row">
        <span className="muted">LED</span>
        <strong>#{sel}</strong>
      </div>
      <div className="insp-row">
        <span className="muted">Position</span>
        <span>{p.x.toFixed(2)}, {p.y.toFixed(2)}, {p.z.toFixed(2)}</span>
      </div>
      <div className="insp-row">
        <span className="muted">Track</span>
        <span>Track 1 (gradient)</span>
      </div>
      <div className="insp-row">
        <span className="muted">Color @ frame {frame}</span>
        <span className="swatch-inline">
          <span className="swatch" style={{ background: rgbToHex(color) }} />
          {rgbToHex(color)}
        </span>
      </div>
    </div>
  )
}
