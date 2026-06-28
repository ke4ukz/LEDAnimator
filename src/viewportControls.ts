import type { Camera } from 'three'

interface ControlsLike {
  target: { set: (x: number, y: number, z: number) => void }
  update: () => void
}

// Shared handle so HTML overlays (outside the R3F Canvas) can drive the camera.
interface Holder {
  camera: Camera | null
  controls: ControlsLike | null
  /** Registered by the in-scene Rig to run an animated home transition. */
  startHome: (() => void) | null
}

export const viewportRefs: Holder = { camera: null, controls: null, startHome: null }

/** Distance used for the default 45°/45° "home" view. */
export const HOME_DISTANCE = 9

/** Return to the default isometric view (animated if the Rig is mounted). */
export function goHome() {
  if (viewportRefs.startHome) {
    viewportRefs.startHome()
    return
  }
  const { camera, controls } = viewportRefs
  if (!camera || !controls) return
  camera.position.set(HOME_DISTANCE, HOME_DISTANCE, HOME_DISTANCE)
  controls.target.set(0, 0, 0)
  controls.update()
}
