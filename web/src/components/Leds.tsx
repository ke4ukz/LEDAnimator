import { useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { Color, type InstancedMesh, Object3D, SRGBColorSpace } from 'three'
import { useStore } from '../store'
import { sampleRaster } from '../types'

const tmpObject = new Object3D()
const tmpColor = new Color()

function Geometry({ shape }: { shape: 'sphere' | 'cube' }) {
  return shape === 'cube' ? <boxGeometry args={[0.5, 0.5, 0.5]} /> : <sphereGeometry args={[0.35, 16, 16]} />
}

/**
 * Renders every LED as an emissive (unlit) instance — sphere or cube — colored
 * from the current raster frame. Clicking an instance selects it (Shift adds).
 */
export function Leds() {
  const ref = useRef<InstancedMesh>(null!)
  const leds = useStore((s) => s.leds)
  const ledScale = useStore((s) => s.ledScale)
  const ledShape = useStore((s) => s.ledShape)
  const selectLed = useStore((s) => s.selectLed)

  // Place + scale instances. ledShape is a dep because the instanced mesh
  // remounts on shape change (new geometry) and the new instances start at the
  // identity matrix until we re-place them.
  useLayoutEffect(() => {
    const mesh = ref.current
    leds.forEach((p, i) => {
      tmpObject.position.set(p.x, p.y, p.z)
      tmpObject.scale.setScalar(ledScale)
      tmpObject.updateMatrix()
      mesh.setMatrixAt(i, tmpObject.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [leds, ledScale, ledShape])

  // Repaint colors from the current frame every render tick. Disabled LEDs show
  // a dim grey (so "off on purpose" reads differently from a black gradient spot).
  useFrame(() => {
    const mesh = ref.current
    const { raster, frame } = useStore.getState()
    const count = Math.min(leds.length, raster.numLeds)
    for (let i = 0; i < count; i++) {
      if (leds[i]?.disabled) {
        tmpColor.setRGB(0.14, 0.14, 0.16, SRGBColorSpace)
      } else {
        const [r, g, b] = sampleRaster(raster, frame, i)
        tmpColor.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)
      }
      mesh.setColorAt(i, tmpColor)
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh
      key={`${leds.length}-${ledShape}`}
      ref={ref}
      args={[undefined, undefined, leds.length]}
      onClick={(e) => {
        e.stopPropagation()
        if (e.instanceId == null) return
        // In the renumber tool a click reassigns chain order instead of selecting.
        const { tool, renumberAt } = useStore.getState()
        if (tool === 'renumber') renumberAt(e.instanceId)
        else selectLed(e.instanceId, e.shiftKey ? 'toggle' : 'replace')
      }}
    >
      <Geometry shape={ledShape} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/** Translucent preview instances for a pending "add shape". */
export function GhostLeds() {
  const ghost = useStore((s) => s.ghost)
  const ledShape = useStore((s) => s.ledShape)
  const ledScale = useStore((s) => s.ledScale)
  const ref = useRef<InstancedMesh>(null!)

  useLayoutEffect(() => {
    if (!ghost || ghost.length === 0) return
    const mesh = ref.current
    ghost.forEach((p, i) => {
      tmpObject.position.set(p.x, p.y, p.z)
      tmpObject.scale.setScalar(ledScale)
      tmpObject.updateMatrix()
      mesh.setMatrixAt(i, tmpObject.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [ghost, ledScale, ledShape])

  if (!ghost || ghost.length === 0) return null
  return (
    <instancedMesh key={`${ghost.length}-${ledShape}`} ref={ref} args={[undefined, undefined, ghost.length]} raycast={() => null}>
      <Geometry shape={ledShape} />
      <meshBasicMaterial color="#5b8ff0" transparent opacity={0.35} toneMapped={false} />
    </instancedMesh>
  )
}

/** Wireframe rings around the selected LEDs (not pickable, so they don't eat clicks). */
export function SelectionMarker() {
  const leds = useStore((s) => s.leds)
  const selection = useStore((s) => s.selection)
  const ledScale = useStore((s) => s.ledScale)
  return (
    <>
      {selection.map((i) => {
        const p = leds[i]
        if (!p) return null
        return (
          <mesh key={i} position={[p.x, p.y, p.z]} scale={ledScale} raycast={() => null}>
            <sphereGeometry args={[0.52, 20, 20]} />
            <meshBasicMaterial color="#ffffff" wireframe toneMapped={false} />
          </mesh>
        )
      })}
    </>
  )
}

/** Red wireframe rings around unassigned LEDs (not in the chain). Not pickable. */
export function UnassignedMarkers() {
  const leds = useStore((s) => s.leds)
  const ledScale = useStore((s) => s.ledScale)
  return (
    <>
      {leds.map((p, i) =>
        p.unassigned ? (
          <mesh key={i} position={[p.x, p.y, p.z]} scale={ledScale} raycast={() => null}>
            <sphereGeometry args={[0.5, 16, 16]} />
            <meshBasicMaterial color="#e0586b" wireframe toneMapped={false} />
          </mesh>
        ) : null,
      )}
    </>
  )
}

/**
 * Optional number labels: small DOM billboards on each LED. Shows the LED's
 * CHAIN number (position among assigned LEDs); unassigned LEDs are skipped.
 */
export function LedLabels() {
  const leds = useStore((s) => s.leds)
  const show = useStore((s) => s.showLabels)
  if (!show) return null
  let n = -1
  return (
    <>
      {leds.map((p, i) => {
        if (p.unassigned) return null
        n += 1
        return (
          <Html key={i} position={[p.x, p.y, p.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div className="led-label">{n}</div>
          </Html>
        )
      })}
    </>
  )
}
