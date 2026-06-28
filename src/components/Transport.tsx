import { useStore } from '../store'

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
      <button className="btn" onClick={() => advance(-1)} title="Step back">⏮</button>
      <button className="btn btn-primary" onClick={togglePlay} title="Play / pause">
        {playing ? '⏸' : '▶'}
      </button>
      <button className="btn" onClick={() => advance(1)} title="Step forward">⏭</button>

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
