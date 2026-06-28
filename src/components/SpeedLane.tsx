import { useRef, useState } from 'react'
import { useStore } from '../store'
import { type EaseType, type Keyframe, type Track, evalAutomation, newId } from '../project'

const H = 44
const TOP = 5
const BOT = H - 5
const VMAX = 4
const VMIN = -4
const STEPS = 80
const EPS = 0.005

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const valueToY = (v: number) => TOP + ((VMAX - v) / (VMAX - VMIN)) * (BOT - TOP)

/**
 * Keyframed speed-over-time editor for a track. Y is speed (0 in the middle,
 * up = faster, down = reverse). Drag keyframes, click empty space to add one,
 * pick an easing curve per keyframe. Built generic enough that offset/chase can
 * reuse the same lane later.
 */
export function SpeedLane({ track }: { track: Track }) {
  const setAutomation = useStore((s) => s.setAutomation)
  const frame = useStore((s) => s.frame)
  const numFrames = useStore((s) => s.raster.numFrames)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragId = useRef<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const auto = track.automations?.speed
  if (!auto) return null
  const keys = auto.keys

  const commit = (next: Keyframe[]) =>
    setAutomation(track.id, 'speed', { keys: [...next].sort((a, b) => a.t - b.t) })

  const fromEvent = (e: { clientX: number; clientY: number }): { t: number; value: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    const t = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const yNorm = clamp((e.clientY - rect.top) / rect.height, 0, 1)
    const value = VMAX - yNorm * (VMAX - VMIN)
    return { t, value: clamp(value, VMIN, VMAX) }
  }

  const onKeyDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation()
    dragId.current = id
    setSelected(id)
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (!dragId.current) return
    const id = dragId.current
    const idx = keys.findIndex((k) => k.id === id)
    if (idx < 0) return
    const { t, value } = fromEvent(e)
    const lo = idx > 0 ? keys[idx - 1].t + EPS : 0
    const hi = idx < keys.length - 1 ? keys[idx + 1].t + -EPS : 1
    const nt = idx === 0 ? 0 : idx === keys.length - 1 ? 1 : clamp(t, lo, hi)
    commit(keys.map((k) => (k.id === id ? { ...k, t: nt, value } : k)))
  }

  const addAt = (e: React.PointerEvent) => {
    const { t, value } = fromEvent(e)
    const k: Keyframe = { id: newId('kf'), t: clamp(t, EPS, 1 - EPS), value, ease: 'linear' }
    commit([...keys, k])
    setSelected(k.id)
  }

  const sel = keys.find((k) => k.id === selected) ?? null
  const curve = Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS
    return `${t * 100},${valueToY(evalAutomation(auto, t))}`
  }).join(' ')

  return (
    <div className="speed-lane">
      <svg
        ref={svgRef}
        className="speed-svg"
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          if (e.target === svgRef.current) addAt(e)
        }}
        onPointerMove={onMove}
        onPointerUp={() => (dragId.current = null)}
      >
        <line x1={0} y1={valueToY(0)} x2={100} y2={valueToY(0)} className="zero-line" />
        <polyline points={curve} className="speed-curve" />
        <line
          className="lane-playhead"
          x1={(frame / numFrames) * 100}
          y1={0}
          x2={(frame / numFrames) * 100}
          y2={H}
        />
        {keys.map((k) => (
          <circle
            key={k.id}
            cx={k.t * 100}
            cy={valueToY(k.value)}
            r={2.6}
            className={`kf${k.id === selected ? ' sel' : ''}`}
            onPointerDown={onKeyDown(k.id)}
          />
        ))}
      </svg>

      <div className="speed-controls">
        {sel ? (
          <>
            <span className="muted">key @ {Math.round(sel.t * 100)}%</span>
            <span>speed {sel.value.toFixed(2)}</span>
            <select
              value={sel.ease}
              onChange={(e) => commit(keys.map((k) => (k.id === sel.id ? { ...k, ease: e.target.value as EaseType } : k)))}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
              <option value="hold">Hold</option>
            </select>
            <button
              className="btn"
              disabled={keys.length <= 1}
              onClick={() => {
                commit(keys.filter((k) => k.id !== sel.id))
                setSelected(null)
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <span className="muted">Click the lane to add a keyframe; drag to move. Up = faster, down = reverse.</span>
        )}
      </div>
    </div>
  )
}
