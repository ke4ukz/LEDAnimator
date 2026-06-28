import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { evalGradient } from '../gradient'

const STRIP_W = 600
const STRIP_H = 40

/**
 * Minimal timeline: one lane for the current (single, implicit) track, showing
 * the gradient's sampled strip with a live playhead. Real multi-track editing
 * arrives with the track system.
 */
export function Timeline() {
  const gradient = useStore((s) => s.gradient)
  const frame = useStore((s) => s.frame)
  const raster = useStore((s) => s.raster)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(STRIP_W, 1)
    for (let x = 0; x < STRIP_W; x++) {
      const [r, g, b] = evalGradient(gradient, x / (STRIP_W - 1), 0.5)
      const i = x * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0, STRIP_W, 1, 0, 0, STRIP_W, STRIP_H)
  }, [gradient])

  const playheadPct = (frame / raster.numFrames) * 100

  return (
    <div className="timeline-lanes">
      <div className="lane">
        <div className="lane-label">
          <span className="dot" />
          Track 1
          <span className="muted">gradient · all LEDs</span>
        </div>
        <div className="lane-strip">
          <canvas ref={canvasRef} width={STRIP_W} height={STRIP_H} className="lane-canvas" />
          <div className="playhead" style={{ left: `${playheadPct}%` }} />
        </div>
      </div>
      <div className="lane add-lane muted">+ Add track (coming with the track system)</div>
    </div>
  )
}
