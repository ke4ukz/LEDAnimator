import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type GradientSource } from '../project'
import { getSourceCanvas, getSourceTexture, sampleNearest } from '../texture'
import { rgbToHex } from '../color'
import { TexturePreview } from './TexturePreview'

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
// Loupe display size in px; drawn from the texture at nearest-neighbor so the
// individual source texels stay crisp when zoomed.
const MAG = 200

/**
 * The focus-mode editing surface: the large texture with its sampling path, a
 * magnifier loupe + color readout for whatever's under the cursor (sampled from
 * the exact export texture), and the full-width ramp below.
 */
export function GradientFocusView({ source, ramp }: { source: GradientSource; ramp: ReactNode }) {
  const [hover, setHover] = useState<{ u: number; v: number } | null>(null)
  const [zoom, setZoom] = useState(4)

  const half = 0.5 / zoom
  // Loupe window centered on the cursor, clamped so it never leaves the texture.
  const cu = hover ? clamp(hover.u, half, 1 - half) : 0.5
  const cv = hover ? clamp(hover.v, half, 1 - half) : 0.5
  const win = { u0: cu - half, v0: cv - half, u1: cu + half, v1: cv + half }
  const crossX = hover ? ((hover.u - win.u0) / (2 * half)) * 100 : 50
  const crossY = hover ? ((hover.v - win.v0) / (2 * half)) * 100 : 50
  // Exactly the texel the export would read here.
  const hex = hover ? rgbToHex(sampleNearest(getSourceTexture(source), hover.u, hover.v)) : ''

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
                <TextureLoupe source={source} win={win} size={MAG} />
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

/** Nearest-neighbor magnification of a cropped texture region, so the source
 *  texels appear as crisp squares — the same pixels the export samples. */
function TextureLoupe({
  source,
  win,
  size,
}: {
  source: GradientSource
  win: { u0: number; v0: number; u1: number; v1: number }
  size: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const src = getSourceCanvas(source)
    const res = src.width
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(
      src,
      win.u0 * res, win.v0 * res, (win.u1 - win.u0) * res, (win.v1 - win.v0) * res,
      0, 0, size, size,
    )
  }, [source, win.u0, win.v0, win.u1, win.v1, size])
  return <canvas ref={ref} width={size} height={size} className="grad-preview" />
}
