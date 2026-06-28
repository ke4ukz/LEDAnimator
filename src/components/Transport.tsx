import { useStore } from '../store'

/** Single-frame step icon: a bar with one triangle (|◀ / ▶|). */
function StepIcon({ dir }: { dir: 'back' | 'fwd' }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      {dir === 'back' ? (
        <>
          <rect x="3" y="3" width="2" height="10" fill="currentColor" />
          <polygon points="13,3 13,13 6,8" fill="currentColor" />
        </>
      ) : (
        <>
          <polygon points="3,3 3,13 10,8" fill="currentColor" />
          <rect x="11" y="3" width="2" height="10" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

/** Global playback transport: play/pause, frame scrub, and a time/rate readout. */
export function Transport() {
  const playing = useStore((s) => s.playing)
  const frame = useStore((s) => s.frame)
  const raster = useStore((s) => s.raster)
  const togglePlay = useStore((s) => s.togglePlay)
  const setFrame = useStore((s) => s.setFrame)
  const advance = useStore((s) => s.advance)

  const durationS = raster.numFrames / raster.fps
  const timeS = frame / raster.fps

  return (
    <div className="transport">
      <button className="btn icon" onClick={() => advance(-1)} title="Step back one frame">
        <StepIcon dir="back" />
      </button>
      <button className="btn btn-primary" onClick={togglePlay} title="Play / pause">
        {playing ? '⏸' : '▶'}
      </button>
      <button className="btn icon" onClick={() => advance(1)} title="Step forward one frame">
        <StepIcon dir="fwd" />
      </button>

      <input
        className="scrub"
        type="range"
        min={0}
        max={raster.numFrames - 1}
        value={frame}
        onChange={(e) => setFrame(Number(e.target.value))}
      />

      <div className="readout">
        <span>{timeS.toFixed(2)}s / {durationS.toFixed(2)}s</span>
        <span className="muted">frame {frame} / {raster.numFrames - 1}</span>
        <span className="muted">{raster.fps} fps · {raster.numLeds} LEDs</span>
      </div>
    </div>
  )
}
