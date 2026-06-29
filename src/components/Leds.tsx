import { useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import { Color, type InstancedMesh, Object3D, SRGBColorSpace } from 'three'
import { useStore } from '../store'
import { sampleRaster } from '../types'

const tmpObject = new Object3D()
const tmpColor = new Color()

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

  // Place + scale instances when the arrangement or size changes, then refresh
  // the bounding sphere so instance picking stays accurate.
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
  }, [leds, ledScale])

  // Repaint colors from the current frame every render tick.
  useFrame(() => {
    const mesh = ref.current
    const { raster, frame } = useStore.getState()
    const count = Math.min(leds.length, raster.numLeds)
    for (let i = 0; i < count; i++) {
      const [r, g, b] = sampleRaster(raster, frame, i)
      tmpColor.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)
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
        if (e.instanceId != null) selectLed(e.instanceId, e.shiftKey)
      }}
    >
      {ledShape === 'cube' ? <boxGeometry args={[0.5, 0.5, 0.5]} /> : <sphereGeometry args={[0.35, 16, 16]} />}
      <meshBasicMaterial toneMapped={false} />
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

/** Optional billboard index labels above each LED. */
export function LedLabels() {
  const leds = useStore((s) => s.leds)
  const show = useStore((s) => s.showLabels)
  const ledScale = useStore((s) => s.ledScale)
  if (!show) return null
  return (
    <>
      {leds.map((p, i) => (
        <Billboard key={i} position={[p.x, p.y + 0.35 * ledScale + 0.28, p.z]}>
          <Text fontSize={0.36} color="#fff" outlineWidth={0.03} outlineColor="#000" anchorX="center" anchorY="middle">
            {i}
          </Text>
        </Billboard>
      ))}
    </>
  )
}
