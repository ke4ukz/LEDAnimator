import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { type Source, type Track, pathPoint, trackParamAt, trackPhaseAt } from '../project'
import { getSourceTexture, sampleNearest } from '../texture'
import { SpeedLane } from './SpeedLane'

const STRIP_W = 600
const STRIP_H = 36
const frac = (x: number) => x - Math.floor(x)

/**
 * The track list + timeline: one lane per track (the source sampled along its
 * path, with a playhead), plus Add/Duplicate and per-lane rename/delete — so the
 * tracks live in one place.
 */
export function Timeline() {
  const tracks = useStore((s) => s.project.tracks)
  const sources = useStore((s) => s.project.sources)
  const selectTrack = useStore((s) => s.selectTrack)
  const selected = useStore((s) => s.selectedTrack)
  const addTrack = useStore((s) => s.addTrack)
  const duplicateTrack = useStore((s) => s.duplicateTrack)
  const deleteTrack = useStore((s) => s.deleteTrack)
  const updateTrack = useStore((s) => s.updateTrack)

  return (
    <div className="timeline-lanes">
      <div className="track-bar">
        <button className="btn" onClick={addTrack}>+ Add</button>
        <button
          className="btn"
          title="Clone the selected track's settings into a new empty track"
          disabled={!selected}
          onClick={() => selected && duplicateTrack(selected)}
        >
          Duplicate
        </button>
      </div>
      {tracks.map((t) => {
        const source = sources.find((s) => s.id === t.sourceId)
        if (!source) return null
        return (
          <Lane
            key={t.id}
            track={t}
            source={source}
            selected={t.id === selected}
            canDelete={tracks.length > 1}
            onSelect={() => selectTrack(t.id)}
            onDelete={() => deleteTrack(t.id)}
            onRename={(name) => updateTrack(t.id, { name })}
          />
        )
      })}
    </div>
  )
}

function Lane({
  track, source, selected, canDelete, onSelect, onDelete, onRename,
}: {
  track: Track
  source: Source
  selected: boolean
  canDelete: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (name: string) => void
}) {
  const frame = useStore((s) => s.frame)
  const raster = useStore((s) => s.raster)
  const showSamples = useStore((s) => s.showSamples)
  const leds = useStore((s) => s.leds)
  const assignments = useStore((s) => s.project.assignments)
  const textureVersion = useStore((s) => s.textureVersion)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [editing, setEditing] = useState(false)

  const commitName = (value: string) => {
    const name = value.trim()
    if (name) onRename(name)
    setEditing(false)
  }

  // Repaint the strip: the source sampled along the path over s ∈ [0,1).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const tex = getSourceTexture(source)
    const img = ctx.createImageData(STRIP_W, 1)
    for (let x = 0; x < STRIP_W; x++) {
      const [u, v] = pathPoint(track.path, x / STRIP_W)
      const [r, g, b] = sampleNearest(tex, u, v)
      const i = x * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0, STRIP_W, 1, 0, 0, STRIP_W, STRIP_H)
  }, [track.path, source, textureVersion])

  // Playhead = where the lead LED (order 0) reads right now (integrate speed).
  const s0 = frac(track.offset + trackPhaseAt(track, frame, raster.numFrames))

  // Optional ghost markers: where each in-chain member LED reads right now.
  const sampleS: number[] = []
  if (showSamples) {
    const t = frame / raster.numFrames
    const phase = trackPhaseAt(track, frame, raster.numFrames)
    const offset = trackParamAt(track, 'offset', t)
    const chase = trackParamAt(track, 'chase', t)
    let rank = 0
    assignments.forEach((id, i) => {
      if (id !== track.id || leds[i]?.unassigned) return
      const idx = leds[i]?.animIndex ?? rank
      rank++
      sampleS.push(frac(offset + idx * chase + phase))
    })
  }

  return (
    <div className={`lane-group${selected ? ' sel' : ''}`}>
      <div className="lane" onClick={onSelect}>
        <div className="lane-label" onDoubleClick={() => setEditing(true)}>
          <span className="dot" />
          {editing ? (
            <input
              className="lane-name-input"
              autoFocus
              defaultValue={track.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  e.currentTarget.value = track.name
                  e.currentTarget.blur()
                }
              }}
            />
          ) : (
            <span className="lane-name" title="Double-click to rename">{track.name}</span>
          )}
          <button
            className="lane-del"
            title="Delete track"
            disabled={!canDelete}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            ×
          </button>
        </div>
        <div className="lane-strip">
          <canvas ref={canvasRef} width={STRIP_W} height={STRIP_H} className="lane-canvas" />
          {sampleS.map((s, i) => (
            <div key={i} className="playhead ghost" style={{ left: `${s * 100}%` }} />
          ))}
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
