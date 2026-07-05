import { useRef } from 'react'
import { useStore } from '../store'
import { type PathDef, type Track, pathPoint, polyOutline, trackParamAt, trackPhaseAt } from '../project'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const frac = (x: number) => x - Math.floor(x)
const DEG = Math.PI / 180

// How close (in normalized preview units) a click must be to a poly segment to
// insert a point on it rather than appending a new one at the end.
const POLY_INSERT_DIST = 0.06

/** The nearest segment insertion for a click at (u,v): the projected point on
 *  the closest edge and the index it should be spliced in at, or null if the
 *  click isn't near any edge. */
function nearestSegmentInsert(
  pts: { x: number; y: number }[],
  closed: boolean,
  u: number,
  v: number,
): { index: number; x: number; y: number } | null {
  const n = pts.length
  if (n < 2) return null
  let best: { d: number; index: number; x: number; y: number } | null = null
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? clamp01(((u - a.x) * dx + (v - a.y) * dy) / len2) : 0
    const px = a.x + dx * t
    const py = a.y + dy * t
    const d = Math.hypot(u - px, v - py)
    if (!best || d < best.d) best = { d, index: i + 1, x: px, y: py }
  }
  return best && best.d <= POLY_INSERT_DIST ? { index: best.index, x: best.x, y: best.y } : null
}

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
  const showSamples = useStore((s) => s.showSamples)
  // Only track `frame` when markers are on, so playback doesn't re-render this
  // (and re-walk the curve) every frame when they're off.
  const frame = useStore((s) => (s.showSamples ? s.frame : 0))
  const numFrames = useStore((s) => s.raster.numFrames)
  const leds = useStore((s) => s.leds)
  const assignments = useStore((s) => s.project.assignments)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<string | null>(null)
  const path = track.path

  // Where each in-chain member LED samples the path at the current frame — dim
  // "ghost" dots showing the chase spread. Shared animation indices overlap.
  // The LED first in the animation series (lowest animation index) is marked
  // distinctly so you can tell which one leads.
  const samplePts: { x: number; y: number; first: boolean }[] = []
  if (showSamples && numFrames > 0) {
    const t = frame / numFrames
    const phase = trackPhaseAt(track, frame, numFrames)
    const offset = trackParamAt(track, 'offset', t)
    const chase = trackParamAt(track, 'chase', t)
    const rows: { idx: number; x: number; y: number }[] = []
    let rank = 0
    let minIdx = Infinity
    assignments.forEach((id, i) => {
      if (id !== track.id || leds[i]?.unassigned) return
      const idx = leds[i]?.animIndex ?? rank
      rank++
      const [u, v] = pathPoint(path, frac(offset + idx * chase + phase))
      rows.push({ idx, x: u * 100, y: v * 100 })
      if (idx < minIdx) minIdx = idx
    })
    for (const r of rows) samplePts.push({ x: r.x, y: r.y, first: r.idx === minIdx })
  }

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
    } else if (p.type === 'poly') {
      const m = /^p(\d+)$/.exec(id)
      if (m) {
        const i = Number(m[1])
        setPath({ ...p, pts: p.pts.map((pt, j) => (j === i ? { x: u, y: v } : pt)) })
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
    if (path.type === 'poly') {
      return path.pts.map((pt, i) => ({ id: `p${i}`, u: clamp01(pt.x), v: clamp01(pt.y), start: i === 0 }))
    }
    return [{ id: 'mid', u: clamp01(path.phase), v: path.midV }, { id: 'amp', u: 0.25, v: clamp01(path.midV - path.amp) }]
  })()

  // Trace the curve. A poly path uses its exact flattened outline (crisp corners
  // and true beziers); the analytic paths are sampled uniformly.
  const pts: [number, number][] =
    path.type === 'poly'
      ? polyOutline(path).map(([u, v]) => [u * 100, v * 100])
      : Array.from({ length: 65 }, (_, i) => {
          const [u, v] = pathPoint(path, i / 64)
          return [u * 100, v * 100] as [number, number]
        })
  const curve = pts.map((p) => `${p[0]},${p[1]}`).join(' ')

  // Arrowhead direction at the path end. Rendered as a fixed-size DOM element
  // (like the handles), not an SVG polygon, so it doesn't balloon when the
  // preview is enlarged. Hidden on a closed loop, where there's no single "end".
  const showArrow = pts.length >= 2 && !(path.type === 'poly' && path.closed)
  const a1 = pts[pts.length - 2] ?? pts[0]
  const a2 = pts[pts.length - 1] ?? pts[0]
  const arrowDeg = (Math.atan2(a2[1] - a1[1], a2[0] - a1[0]) * 180) / Math.PI

  return (
    <div
      ref={ref}
      className="path-overlay"
      onPointerDown={(e) => {
        // Clicking empty preview space (not a handle) adds a poly point: on the
        // line if the click lands near a segment, else appended at the end.
        if (path.type !== 'poly' || e.target !== ref.current) return
        const { u, v } = fromEvent(e)
        const ins = nearestSegmentInsert(path.pts, path.closed, u, v)
        const pts = [...path.pts]
        if (ins) pts.splice(ins.index, 0, { x: ins.x, y: ins.y })
        else pts.push({ x: u, y: v })
        setPath({ ...path, pts })
      }}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      {showArrow && (
        <div
          className="path-arrow-el"
          style={{ left: `${a2[0]}%`, top: `${a2[1]}%`, transform: `translate(-50%, -50%) rotate(${arrowDeg}deg)` }}
        />
      )}
      <svg className="path-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={curve} className="path-curve" />
        {samplePts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={p.first ? 2.8 : 2} className={p.first ? 'path-sample first' : 'path-sample'} />
        ))}
      </svg>
      {handles.map((h) => (
        <button
          key={h.id}
          className={`path-handle${h.start ? ' start' : ''}`}
          title={path.type === 'poly' ? 'Drag to move · double-click to remove' : h.start ? 'Start' : undefined}
          style={{ left: `${h.u * 100}%`, top: `${h.v * 100}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            drag.current = h.id
            ;(e.target as Element).setPointerCapture(e.pointerId)
          }}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={(e) => {
            // Double-click removes a poly point (keeping at least two).
            if (path.type !== 'poly' || path.pts.length <= 2) return
            e.stopPropagation()
            const m = /^p(\d+)$/.exec(h.id)
            if (m) setPath({ ...path, pts: path.pts.filter((_, j) => j !== Number(m[1])) })
          }}
        />
      ))}
    </div>
  )
}
