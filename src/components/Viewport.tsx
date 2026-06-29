import { useEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'
import { GhostLeds, LedLabels, Leds, SelectionMarker } from './Leds'
import { HOME_DISTANCE, goHome, viewportRefs } from '../viewportControls'
import { useStore } from '../store'

const HOME_DURATION = 0.5 // seconds
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

interface HomeAnim {
  from: Vector3
  to: Vector3
  fromT: Vector3
  toT: Vector3
  elapsed: number
}

/**
 * Bridges the R3F scene to the outside world: registers the camera + controls,
 * makes Shift the pan modifier (Shift + left-drag pans), and runs the animated
 * Home transition (so it eases to the view like the gizmo faces do).
 */
function Rig() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as
    | ({ target: Vector3; update: () => void } & object)
    | null
  const anim = useRef<HomeAnim | null>(null)

  useEffect(() => {
    viewportRefs.camera = camera
    viewportRefs.controls = controls
  }, [camera, controls])

  useEffect(() => {
    if (!controls) return
    viewportRefs.startHome = () => {
      anim.current = {
        from: camera.position.clone(),
        to: new Vector3(HOME_DISTANCE, HOME_DISTANCE, HOME_DISTANCE),
        fromT: controls.target.clone(),
        toT: new Vector3(0, 0, 0),
        elapsed: 0,
      }
    }
    return () => {
      viewportRefs.startHome = null
    }
  }, [camera, controls])

  useFrame((_, delta) => {
    const a = anim.current
    if (!a || !controls) return
    a.elapsed += delta
    const p = Math.min(1, a.elapsed / HOME_DURATION)
    const e = easeInOut(p)
    camera.position.lerpVectors(a.from, a.to, e)
    controls.target.lerpVectors(a.fromT, a.toT, e)
    controls.update()
    if (p >= 1) anim.current = null
  })

  return null
}

/** The 3D simulation viewport: orbitable camera playing the baked animation. */
export function Viewport() {
  const clearSelection = useStore((s) => s.clearSelection)
  return (
    <>
      <Canvas
        camera={{ position: [HOME_DISTANCE, HOME_DISTANCE, HOME_DISTANCE], fov: 50, up: [0, 0, 1] }}
        dpr={[1, 2]}
        onPointerMissed={(e) => {
          if (!(e as PointerEvent).shiftKey) clearSelection()
        }}
      >
        <color attach="background" args={['#0b0d12']} />
        {/* Z-up: rotate the grid into the XY (ground) plane. */}
        <gridHelper args={[20, 20, '#252b3b', '#161a24']} rotation={[Math.PI / 2, 0, 0]} />
        <Leds />
        <GhostLeds />
        <SelectionMarker />
        <LedLabels />
        <OrbitControls makeDefault enableDamping />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#e0586b', '#7bd06a', '#5b8ff0']} labelColor="#cfd6e4" />
        </GizmoHelper>
        <Rig />
      </Canvas>
      <button className="home-btn" onClick={goHome} title="Reset to default 45°/45° view">
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 2 12h3v9h6v-6h2v6h6v-9h3z" fill="currentColor" />
        </svg>
      </button>
    </>
  )
}
