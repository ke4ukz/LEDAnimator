import { useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei'
import { MOUSE } from 'three'
import { Leds, SelectionMarker } from './Leds'
import { HOME_DISTANCE, goHome, viewportRefs } from '../viewportControls'

/**
 * Bridges the R3F scene to the outside world: registers the camera + controls
 * for the Home button, and makes Shift the pan modifier (Shift + left-drag pans
 * instead of rotating).
 */
function Rig() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as
    | { mouseButtons: { LEFT: MOUSE }; target: { set: (x: number, y: number, z: number) => void }; update: () => void }
    | null

  useEffect(() => {
    viewportRefs.camera = camera
    viewportRefs.controls = controls
  }, [camera, controls])

  useEffect(() => {
    if (!controls) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return
      controls.mouseButtons.LEFT = e.type === 'keydown' ? MOUSE.PAN : MOUSE.ROTATE
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [controls])

  return null
}

/** The 3D simulation viewport: orbitable camera playing the baked animation. */
export function Viewport() {
  return (
    <>
      <Canvas camera={{ position: [HOME_DISTANCE, HOME_DISTANCE, HOME_DISTANCE], fov: 50 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b0d12']} />
        <gridHelper args={[20, 20, '#252b3b', '#161a24']} />
        <Leds />
        <SelectionMarker />
        <OrbitControls makeDefault enableDamping />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#e0586b', '#7bd06a', '#5b8ff0']} labelColor="#cfd6e4" />
        </GizmoHelper>
        <Rig />
      </Canvas>
      <button className="home-btn" onClick={goHome} title="Reset to default 45°/45° view">
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3 2 12h3v9h6v-6h2v6h6v-9h3z"
            fill="currentColor"
          />
        </svg>
      </button>
    </>
  )
}
