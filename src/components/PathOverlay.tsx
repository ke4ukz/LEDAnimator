import { useRef } from 'react'
import { useStore } from '../store'
import { type PathDef, type Track, pathPoint } from '../project'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

interface Handle {
  id: string
  u: number
  v: number
}

/**
 * Draggable sampling-path editor drawn over the source preview. Handles are
 * HTML elements (so they stay circular over a non-square preview); the path
 * itself is an SVG polyline. Edits the selected track's path live.
 */
export function PathOverlay({ track }: { track: Track }) {
  const updateTrack = useStore((s) => s.updateTrack)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<string | null>(null)
  const path = track.path

  const setPath = (p: PathDef) => updateTrack(track.id, { path: p })

  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return { u: clamp01((e.clientX - r.left) / r.width), v: clamp01((e.clientY - r.top) / r.height) }
  }

  const onMove = (e: React.PointerEvent) => {
    const id = drag.current
    if (!id) return
    const { u, v } = fromEvent(e)
    if (path.type === 'line') {
      setPath(id === 'a' ? { ...path, x0: u, y0: v } : { ...path, x1: u, y1: v })
    } else if (path.type === 'circle') {
      setPath(id === 'c' ? { ...path, cx: u, cy: v } : { ...path, r: Math.hypot(u - path.cx, v - path.cy) })
    } else {
      setPath(id === 'mid' ? { ...path, midV: v } : { ...path, amp: clamp01(Math.abs(v - path.midV)) })
    }
  }

  const handles: Handle[] =
    path.type === 'line'
      ? [{ id: 'a', u: path.x0, v: path.y0 }, { id: 'b', u: path.x1, v: path.y1 }]
      : path.type === 'circle'
        ? [{ id: 'c', u: path.cx, v: path.cy }, { id: 'r', u: clamp01(path.cx + path.r), v: path.cy }]
        : [{ id: 'mid', u: 0.5, v: path.midV }, { id: 'amp', u: 0.25, v: clamp01(path.midV - path.amp) }]

  const curve = Array.from({ length: 65 }, (_, i) => {
    const [u, v] = pathPoint(path, i / 64)
    return `${u * 100},${v * 100}`
  }).join(' ')

  return (
    <div
      ref={ref}
      className="path-overlay"
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      <svg className="path-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={curve} className="path-curve" />
      </svg>
      {handles.map((h) => (
        <button
          key={h.id}
          className="path-handle"
          style={{ left: `${h.u * 100}%`, top: `${h.v * 100}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            drag.current = h.id
            ;(e.target as Element).setPointerCapture(e.pointerId)
          }}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
        />
      ))}
    </div>
  )
}
