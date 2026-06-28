import type { Camera } from 'three'

// Shared handle so HTML overlays (outside the R3F Canvas) can drive the camera.
interface Holder {
  camera: Camera | null
  controls: { target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null
}

export const viewportRefs: Holder = { camera: null, controls: null }

/** Distance used for the default 45°/45° "home" view. */
export const HOME_DISTANCE = 9

/** Reset the camera to the default isometric (45°/45°) view. */
export function goHome() {
  const { camera, controls } = viewportRefs
  if (!camera || !controls) return
  camera.position.set(HOME_DISTANCE, HOME_DISTANCE, HOME_DISTANCE)
  controls.target.set(0, 0, 0)
  controls.update()
}
