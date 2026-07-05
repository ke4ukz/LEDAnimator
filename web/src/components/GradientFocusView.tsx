import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type GradientSource } from '../project'
import { getSourceCanvas, getSourceTexture, sampleNearest } from '../texture'
import { rgbToHex } from '../color'
import { TexturePreview } from './TexturePreview'

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
  const span = 2 * half
  // The loupe window is centered on the *texel* under the cursor (snapped to the
  // pixel grid), so the reticle stays fixed dead-center and the image steps one
  // pixel at a time beneath it. Not clamped: near an edge the window runs off the
  // texture and the loupe simply shows blank there, which reads more naturally
  // than sliding the reticle. The framed texel is exactly what the export reads.
  const tex = hover ? getSourceTexture(source) : null
  let win: { u0: number; v0: number; u1: number; v1: number } | null = null
  let pixelSize = 0
  let hex = ''
  if (hover && tex) {
    const res = tex.res
    const xi = Math.min(res - 1, Math.max(0, Math.floor(hover.u * res)))
    const yi = Math.min(res - 1, Math.max(0, Math.floor(hover.v * res)))
    const uc = (xi + 0.5) / res
    const vc = (yi + 0.5) / res
    win = { u0: uc - half, v0: vc - half, u1: uc + half, v1: vc + half }
    pixelSize = (1 / res / span) * 100
    hex = rgbToHex(sampleNearest(tex, hover.u, hover.v))
  }

  return (
    <div className="grad-editor focus">
      <div className="focus-main">
        <TexturePreview large onHover={setHover} />
        <div className="focus-magnifier">
          <div className="field-row">
            <span>Zoom</span>
            <input type="range" min={2} max={32} step={1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            <span className="muted num">{zoom}×</span>
          </div>
          <div className="mag-view">
            {hover && win ? (
              <>
                <TextureLoupe source={source} win={win} size={MAG} />
                <div className="mag-pixel" style={{ width: `${pixelSize}%`, height: `${pixelSize}%` }} />
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

    // Source rect in texels; the window may extend past the texture near an edge.
    const sx = win.u0 * res
    const sy = win.v0 * res
    const sw = (win.u1 - win.u0) * res
    const sh = (win.v1 - win.v0) * res
    const scale = size / sw // dest px per source texel (sw === sh, square window)
    // Clip to the texture and map only the in-bounds part into dest, leaving the
    // rest cleared (blank) rather than stretching edge pixels.
    const cx0 = Math.max(0, sx)
    const cy0 = Math.max(0, sy)
    const cx1 = Math.min(res, sx + sw)
    const cy1 = Math.min(res, sy + sh)
    if (cx1 > cx0 && cy1 > cy0) {
      ctx.drawImage(
        src,
        cx0, cy0, cx1 - cx0, cy1 - cy0,
        (cx0 - sx) * scale, (cy0 - sy) * scale, (cx1 - cx0) * scale, (cy1 - cy0) * scale,
      )
    }
  }, [source, win.u0, win.v0, win.u1, win.v1, size])
  return <canvas ref={ref} width={size} height={size} className="grad-preview" />
}
