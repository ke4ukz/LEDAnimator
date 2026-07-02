import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { type Source, type Track, evalSource, pathPoint, trackPhaseAt } from '../project'
import { SpeedLane } from './SpeedLane'

const STRIP_W = 600
const STRIP_H = 36
const frac = (x: number) => x - Math.floor(x)

/** One lane per track: the source sampled along the track's path, with a playhead. */
export function Timeline() {
  const tracks = useStore((s) => s.project.tracks)
  const sources = useStore((s) => s.project.sources)
  const selectTrack = useStore((s) => s.selectTrack)
  const selected = useStore((s) => s.selectedTrack)

  return (
    <div className="timeline-lanes">
      {tracks.map((t) => {
        const source = sources.find((s) => s.id === t.sourceId)
        if (!source) return null
        return (
          <Lane
            key={t.id}
            track={t}
            source={source}
            selected={t.id === selected}
            onSelect={() => selectTrack(t.id)}
          />
        )
      })}
    </div>
  )
}

function Lane({
  track, source, selected, onSelect,
}: {
  track: Track; source: Source; selected: boolean; onSelect: () => void
}) {
  const frame = useStore((s) => s.frame)
  const raster = useStore((s) => s.raster)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Repaint the strip: the source sampled along the path over s ∈ [0,1).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(STRIP_W, 1)
    for (let x = 0; x < STRIP_W; x++) {
      const [u, v] = pathPoint(track.path, x / STRIP_W)
      const [r, g, b] = evalSource(source, u, v)
      const i = x * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0, STRIP_W, 1, 0, 0, STRIP_W, STRIP_H)
  }, [track.path, source])

  // Playhead = where the lead LED (order 0) reads right now (integrate speed).
  const s0 = frac(track.offset + trackPhaseAt(track, frame, raster.numFrames))

  return (
    <div className={`lane-group${selected ? ' sel' : ''}`}>
      <div className="lane" onClick={onSelect}>
        <div className="lane-label">
          <span className="dot" />
          {track.name}
        </div>
        <div className="lane-strip">
          <canvas ref={canvasRef} width={STRIP_W} height={STRIP_H} className="lane-canvas" />
          <div className="playhead" style={{ left: `${s0 * 100}%` }} />
        </div>
      </div>
      {selected && track.automations?.speed && (
        <div className="lane">
          <div className="lane-label sub">
            <span className="muted">speed</span>
          </div>
          <SpeedLane track={track} />
        </div>
      )}
    </div>
  )
}
