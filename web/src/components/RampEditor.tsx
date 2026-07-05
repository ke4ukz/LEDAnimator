import { useEffect, useRef, useState } from 'react'
import { type InterpSpace, hexToRgb, rgbToHex, sampleRamp } from '../color'
import { type GradientStop, makeStop } from '../gradient'

// Canvas drawing resolution (independent of on-screen width, which is CSS-
// driven so the bar can be small in the panel or full-width when `large`).
const RES = 512
const HEIGHT = 26
const SMALL_W = 224

/**
 * Editable color ramp: a live preview bar with draggable stop handles. Click the
 * bar to add a stop, drag a handle to move it, and edit/delete the selected one.
 * `large` stretches the bar to fill its container (used in the focus editor).
 */
export function RampEditor({
  stops,
  interp,
  onChange,
  large = false,
}: {
  stops: GradientStop[]
  interp: InterpSpace
  onChange: (stops: GradientStop[]) => void
  large?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(stops[0]?.id ?? null)
  const dragId = useRef<string | null>(null)

  // Repaint the ramp bar whenever stops or interpolation change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(RES, 1)
    for (let x = 0; x < RES; x++) {
      const [r, g, b] = sampleRamp(stops, x / (RES - 1), interp)
      const i = x * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
    // Stretch the 1px row down the bar.
    ctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0, RES, 1, 0, 0, RES, HEIGHT)
  }, [stops, interp])

  const posFromEvent = (clientX: number): number => {
    const rect = barRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const sorted = [...stops].sort((a, b) => a.pos - b.pos)
  const sel = stops.find((s) => s.id === selected) ?? null

  const updateStop = (id: string, patch: Partial<GradientStop>) =>
    onChange(stops.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const addStopAt = (pos: number) => {
    const color = sampleRamp(stops, pos, interp)
    const s = makeStop(pos, color)
    onChange([...stops, s])
    setSelected(s.id)
  }

  const deleteStop = (id: string) => {
    if (stops.length <= 2) return
    onChange(stops.filter((s) => s.id !== id))
    setSelected(null)
  }

  return (
    <div className={`ramp${large ? ' large' : ''}`}>
      <div
        ref={barRef}
        className="ramp-bar"
        style={large ? { width: '100%', height: 40 } : { width: SMALL_W, height: HEIGHT }}
        onPointerDown={(e) => {
          // Click on the bar background adds a stop.
          if (e.target === e.currentTarget || e.target === canvasRef.current) {
            addStopAt(posFromEvent(e.clientX))
          }
        }}
        onPointerMove={(e) => {
          if (dragId.current) updateStop(dragId.current, { pos: posFromEvent(e.clientX) })
        }}
        onPointerUp={() => (dragId.current = null)}
        onPointerLeave={() => (dragId.current = null)}
      >
        <canvas ref={canvasRef} width={RES} height={HEIGHT} className="ramp-canvas" />
        {sorted.map((s) => (
          <button
            key={s.id}
            className={`ramp-handle${s.id === selected ? ' selected' : ''}`}
            style={{ left: `${s.pos * 100}%`, background: rgbToHex(s.color) }}
            title={`${Math.round(s.pos * 100)}%`}
            onPointerDown={(e) => {
              e.stopPropagation()
              dragId.current = s.id
              setSelected(s.id)
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (dragId.current === s.id) updateStop(s.id, { pos: posFromEvent(e.clientX) })
            }}
            onPointerUp={() => (dragId.current = null)}
          />
        ))}
      </div>

      <div className="ramp-controls">
        {sel ? (
          <>
            <input
              type="color"
              value={rgbToHex(sel.color)}
              onChange={(e) => updateStop(sel.id, { color: hexToRgb(e.target.value) })}
            />
            <label className="num">
              pos
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={Number(sel.pos.toFixed(3))}
                onChange={(e) => updateStop(sel.id, { pos: Number(e.target.value) })}
              />
            </label>
            <button className="btn" disabled={stops.length <= 2} onClick={() => deleteStop(sel.id)}>
              Delete
            </button>
          </>
        ) : (
          <span className="muted">Click the bar to add a stop; drag handles to move.</span>
        )}
      </div>
    </div>
  )
}
