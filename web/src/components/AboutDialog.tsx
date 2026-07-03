import { buildTime, commit } from 'virtual:build-info'

const BUILD = `${commit} · ${new Date(buildTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`

/** About modal: what the tool is, how the exported data file works, and the build stamp. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>About LED Animator</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        <div className="dialog-prose">
          <p>
            LED Animator is an in-browser editor for authoring LED animations and baking them into a
            simple, fixed-rate data file that a microcontroller can play back with a trivial loop.
          </p>

          <h3 className="dialog-subhead">How the export works</h3>
          <p>
            Everything you author — gradients, tracks, paths, and the 3D arrangement — is sampled into a{' '}
            <strong>linear timeline</strong>: a flat sequence of frames at one fixed frame rate.
          </p>
          <ul>
            <li>Each frame is just one color per LED (RGB888), stored back-to-back (frame-major).</li>
            <li>
              The file is a 16-byte header — magic <code>LEDA</code>, version, pixel format, LED count,
              frame count, and FPS — followed by the raw frame data.
            </li>
            <li>
              On the device there are no keyframes, no interpolation, and no per-track timing: it steps
              through the array one frame at a time at the fixed rate and pushes out the pixels.
            </li>
          </ul>
          <p className="muted">
            That trades a larger file for dead-simple, rock-solid playback — the firmware is only a few lines.
          </p>
        </div>

        <p className="build-line">Build {BUILD}</p>
      </div>
    </div>
  )
}
