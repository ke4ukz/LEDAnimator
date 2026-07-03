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
            Everything you author — gradients, tracks, paths, and the 3D arrangement — is baked into a{' '}
            <strong>linear timeline</strong>: a flat sequence of frames at one fixed frame rate, where each
            frame simply holds a color for every LED.
          </p>
          <p>
            The device plays those frames back one after another at that fixed rate — no keyframes, no
            interpolation, no timing logic on the device. That keeps playback rock-solid and the firmware
            just a few lines.
          </p>
        </div>

        <p className="build-line">Build {BUILD}</p>
      </div>
    </div>
  )
}
