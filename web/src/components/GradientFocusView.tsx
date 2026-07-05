import { type ReactNode, useState } from 'react'
import { type GradientSource, evalSource } from '../project'
import { rgbToHex } from '../color'
import { TexturePreview } from './TexturePreview'
import { GradientPreview } from './GradientPreview'

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
// Loupe render resolution (CSS-scaled up to fill the box; smooth is fine).
const MAG = 160

/**
 * The focus-mode editing surface: the large texture with its sampling path, a
 * magnifier loupe + color readout for whatever's under the cursor, and the
 * full-width ramp below. Hover state lives here so the loupe can track it.
 */
export function GradientFocusView({ source, ramp }: { source: GradientSource; ramp: ReactNode }) {
  const [hover, setHover] = useState<{ u: number; v: number } | null>(null)
  const [zoom, setZoom] = useState(4)

  const half = 0.5 / zoom
  // Loupe window centered on the cursor, clamped so it never leaves the texture.
  const cu = hover ? clamp(hover.u, half, 1 - half) : 0.5
  const cv = hover ? clamp(hover.v, half, 1 - half) : 0.5
  const view = { u0: cu - half, v0: cv - half, u1: cu + half, v1: cv + half }
  const crossX = hover ? ((hover.u - view.u0) / (2 * half)) * 100 : 50
  const crossY = hover ? ((hover.v - view.v0) / (2 * half)) * 100 : 50
  const hex = hover ? rgbToHex(evalSource(source, hover.u, hover.v)) : ''

  return (
    <div className="grad-editor focus">
      <div className="focus-main">
        <TexturePreview large onHover={setHover} />
        <div className="focus-magnifier">
          <div className="field-row">
            <span>Zoom</span>
            <input type="range" min={2} max={16} step={1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            <span className="muted num">{zoom}×</span>
          </div>
          <div className="mag-view">
            {hover ? (
              <>
                <GradientPreview gradient={source.gradient} post={source.post} width={MAG} height={MAG} view={view} />
                <div className="mag-cross" style={{ left: `${crossX}%`, top: `${crossY}%` }} />
              </>
            ) : (
              <div className="mag-empty muted">Hover the texture</div>
            )}
          </div>
          <div className="swatch-row">
            <div className="swatch" style={{ background: hex || 'transparent' }} />
            <span className="mono">{hex || '—'}</span>
          </div>
        </div>
      </div>
      <span className="muted preview-hint">Drag the path handles and the stop nodes below.</span>
      {ramp}
    </div>
  )
}
