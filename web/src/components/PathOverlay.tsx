import { useRef } from 'react'
import { useStore } from '../store'
import { type PathDef, type Track, pathPoint } from '../project'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const DEG = Math.PI / 180

interface Handle {
  id: string
  u: number
  v: number
  start?: boolean
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
    const p = path
    const { u, v } = fromEvent(e)
    if (p.type === 'line') {
      setPath(id === 'a' ? { ...p, x0: u, y0: v } : { ...p, x1: u, y1: v })
    } else if (p.type === 'ellipse') {
      if (id === 'c') return setPath({ ...p, cx: u, cy: v })
      const r = (p.rot ?? 0) * DEG
      const du = u - p.cx
      const dv = v - p.cy
      if (id === 'rx') setPath({ ...p, rx: Math.abs(du * Math.cos(r) + dv * Math.sin(r)) })
      else if (id === 'ry') setPath({ ...p, ry: Math.abs(-du * Math.sin(r) + dv * Math.cos(r)) })
      else if (id === 'rot') setPath({ ...p, rot: Math.atan2(dv, du) / DEG })
    } else if (p.type === 'spiral') {
      if (id === 'c') setPath({ ...p, cx: u, cy: v })
      else if (id === 'outer') setPath({ ...p, r1: Math.hypot(u - p.cx, v - p.cy) })
    } else if (p.type === 'polygon') {
      if (id === 'c') setPath({ ...p, cx: u, cy: v })
      else if (id === 'vtx') {
        const du = u - p.cx
        const dv = v - p.cy
        // Vertex 0 sits at (rot − 90°); recover both size and angle from the drag.
        setPath({ ...p, size: Math.hypot(du, dv), rot: Math.atan2(dv, du) / DEG + 90 })
      }
    } else {
      // sine: bias node sets vertical (midV) and horizontal (phase);
      // amplitude is signed so dragging past the midline flips the wave.
      if (id === 'mid') setPath({ ...p, midV: v, phase: clamp01(u) })
      else setPath({ ...p, amp: clamp(p.midV - v, -1, 1) })
    }
  }

  const handles: Handle[] = (() => {
    if (path.type === 'line') {
      return [{ id: 'a', u: path.x0, v: path.y0, start: true }, { id: 'b', u: path.x1, v: path.y1 }]
    }
    if (path.type === 'ellipse') {
      const r = (path.rot ?? 0) * DEG
      const at = (mx: number, my: number): [number, number] => [
        path.cx + mx * Math.cos(r) - my * Math.sin(r),
        path.cy + mx * Math.sin(r) + my * Math.cos(r),
      ]
      const rx = at(path.rx, 0)
      const ry = at(0, path.ry)
      const rot = at(path.rx + 0.12, 0)
      return [
        { id: 'c', u: path.cx, v: path.cy },
        { id: 'rx', u: clamp01(rx[0]), v: clamp01(rx[1]) },
        { id: 'ry', u: clamp01(ry[0]), v: clamp01(ry[1]) },
        { id: 'rot', u: clamp01(rot[0]), v: clamp01(rot[1]) },
      ]
    }
    if (path.type === 'spiral') {
      const [ox, oy] = pathPoint(path, 1)
      return [
        { id: 'c', u: path.cx, v: path.cy },
        { id: 'outer', u: clamp01(ox), v: clamp01(oy) },
      ]
    }
    if (path.type === 'polygon') {
      const a = (path.rot ?? 0) * DEG - Math.PI / 2
      return [
        { id: 'c', u: path.cx, v: path.cy },
        { id: 'vtx', u: clamp01(path.cx + path.size * Math.cos(a)), v: clamp01(path.cy + path.size * Math.sin(a)) },
      ]
    }
    return [{ id: 'mid', u: clamp01(path.phase), v: path.midV }, { id: 'amp', u: 0.25, v: clamp01(path.midV - path.amp) }]
  })()

  const pts = Array.from({ length: 65 }, (_, i) => {
    const [u, v] = pathPoint(path, i / 64)
    return [u * 100, v * 100] as [number, number]
  })
  const curve = pts.map((p) => `${p[0]},${p[1]}`).join(' ')

  // Arrowhead at the end of the path, pointing along its direction.
  const a1 = pts[pts.length - 2]
  const a2 = pts[pts.length - 1]
  const dlen = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]) || 1
  const ux = (a2[0] - a1[0]) / dlen
  const uy = (a2[1] - a1[1]) / dlen
  const bx = a2[0] - ux * 5
  const by = a2[1] - uy * 5
  const arrow = `${a2[0]},${a2[1]} ${bx - uy * 3},${by + ux * 3} ${bx + uy * 3},${by - ux * 3}`

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
        <polygon points={arrow} className="path-arrow" />
      </svg>
      {handles.map((h) => (
        <button
          key={h.id}
          className={`path-handle${h.start ? ' start' : ''}`}
          title={h.start ? 'Start' : undefined}
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
