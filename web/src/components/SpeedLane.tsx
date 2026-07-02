import { useRef, useState } from 'react'
import { useStore } from '../store'
import { type EaseType, type Keyframe, type Track, evalAutomation, newId } from '../project'

const VMAX = 4
const VMIN = -4
const PAD = 10 // % padding top/bottom inside the graph
const STEPS = 100
const EPS = 0.005
const GRID = [4, 2, 0, -2, -4]

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
/** value → vertical % (0 top, 100 bottom). */
const valueToY = (v: number) => PAD + ((VMAX - v) / (VMAX - VMIN)) * (100 - 2 * PAD)

/**
 * Keyframed speed-over-time editor. Y is speed (0 in the middle, up = faster,
 * down = reverse). Handles are HTML elements over an SVG curve so they stay
 * circular regardless of the lane's width. Generic enough that offset/chase can
 * reuse it later.
 */
export function SpeedLane({ track }: { track: Track }) {
  const setAutomation = useStore((s) => s.setAutomation)
  const frame = useStore((s) => s.frame)
  const numFrames = useStore((s) => s.raster.numFrames)
  const graphRef = useRef<HTMLDivElement>(null)
  const dragId = useRef<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const auto = track.automations?.speed
  if (!auto) return null
  const keys = auto.keys

  const commit = (next: Keyframe[]) =>
    setAutomation(track.id, 'speed', { keys: [...next].sort((a, b) => a.t - b.t), linkEnds: auto.linkEnds })

  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = graphRef.current!.getBoundingClientRect()
    const t = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    const inner = clamp((yPct - PAD) / (100 - 2 * PAD), 0, 1)
    const value = VMAX - inner * (VMAX - VMIN)
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
    const isEnd = idx === 0 || idx === keys.length - 1
    const lo = idx > 0 ? keys[idx - 1].t + EPS : 0
    const hi = idx < keys.length - 1 ? keys[idx + 1].t - EPS : 1
    const nt = idx === 0 ? 0 : idx === keys.length - 1 ? 1 : clamp(t, lo, hi)
    let next = keys.map((k) => (k.id === id ? { ...k, t: nt, value } : k))
    // Linked endpoints share a value so the loop is seamless.
    if (auto.linkEnds && isEnd && keys.length >= 2) {
      next = next.map((k, i) => (i === 0 || i === next.length - 1 ? { ...k, value } : k))
    }
    commit(next)
  }

  const addAt = (e: React.PointerEvent) => {
    const { t, value } = fromEvent(e)
    const k: Keyframe = { id: newId('kf'), t: clamp(t, EPS, 1 - EPS), value, ease: 'linear' }
    commit([...keys, k])
    setSelected(k.id)
  }

  const toggleLink = () => {
    const linkEnds = !auto.linkEnds
    let next = keys
    if (linkEnds && keys.length >= 2) {
      const v = keys[0].value
      next = keys.map((k, i) => (i === keys.length - 1 ? { ...k, value: v } : k))
    }
    setAutomation(track.id, 'speed', { keys: next, linkEnds })
  }

  const sel = keys.find((k) => k.id === selected) ?? null
  const curve = Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS
    return `${t * 100},${valueToY(evalAutomation(auto, t))}`
  }).join(' ')

  return (
    <div className="speed-lane">
      <div
        ref={graphRef}
        className="speed-graph"
        onPointerDown={(e) => {
          if (e.target !== graphRef.current && !(e.target as Element).classList.contains('speed-svg')) return
          addAt(e)
        }}
        onPointerMove={onMove}
        onPointerUp={() => (dragId.current = null)}
      >
        <svg className="speed-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          {GRID.map((s) => (
            <line key={s} x1={0} y1={valueToY(s)} x2={100} y2={valueToY(s)} className={s === 0 ? 'zero-line' : 'grid-line'} />
          ))}
          <polyline points={curve} className="speed-curve" />
          <line className="lane-playhead" x1={(frame / numFrames) * 100} y1={0} x2={(frame / numFrames) * 100} y2={100} />
        </svg>
        {GRID.map((s) => (
          <span key={s} className="grid-label" style={{ top: `${valueToY(s)}%` }}>{s > 0 ? `+${s}` : s}</span>
        ))}
        {keys.map((k) => (
          <button
            key={k.id}
            className={`kf-handle${k.id === selected ? ' sel' : ''}`}
            style={{ left: `${k.t * 100}%`, top: `${valueToY(k.value)}%` }}
            title={`t ${Math.round(k.t * 100)}% · speed ${k.value.toFixed(2)}`}
            onPointerDown={onKeyDown(k.id)}
            onPointerMove={onMove}
            onPointerUp={() => (dragId.current = null)}
          />
        ))}
      </div>

      <div className="speed-controls">
        <label className="link-ends">
          <input type="checkbox" checked={!!auto.linkEnds} onChange={toggleLink} />
          Link ends
        </label>
        {sel && (
          <>
            <span className="muted">@ {Math.round(sel.t * 100)}% · {sel.value.toFixed(2)}</span>
            <select value={sel.ease} onChange={(e) => commit(keys.map((k) => (k.id === sel.id ? { ...k, ease: e.target.value as EaseType } : k)))}>
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
              <option value="hold">Hold</option>
            </select>
            <button
              className="btn"
              disabled={keys.length <= 1}
              onClick={() => { commit(keys.filter((k) => k.id !== sel.id)); setSelected(null) }}
            >
              Delete key
            </button>
          </>
        )}
      </div>
    </div>
  )
}
