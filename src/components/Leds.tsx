import { useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, type InstancedMesh, Object3D, SRGBColorSpace } from 'three'
import { useStore } from '../store'
import { sampleRaster } from '../types'

const tmpObject = new Object3D()
const tmpColor = new Color()

/**
 * Renders every LED as an emissive (unlit) sphere whose color is read from the
 * current raster frame each tick. Uses a single InstancedMesh so thousands of
 * LEDs stay cheap.
 */
export function Leds() {
  const ref = useRef<InstancedMesh>(null!)
  const leds = useStore((s) => s.leds)
  const selectLed = useStore((s) => s.selectLed)

  // Lay out instance positions whenever the arrangement changes.
  useLayoutEffect(() => {
    const mesh = ref.current
    leds.forEach((p, i) => {
      tmpObject.position.set(p.x, p.y, p.z)
      tmpObject.updateMatrix()
      mesh.setMatrixAt(i, tmpObject.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [leds])

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
      key={leds.length}
      ref={ref}
      args={[undefined, undefined, leds.length]}
      onClick={(e) => {
        e.stopPropagation()
        if (e.instanceId != null) selectLed(e.instanceId, e.shiftKey)
      }}
    >
      <sphereGeometry args={[0.35, 16, 16]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

/** Wireframe rings around the currently selected LEDs. */
export function SelectionMarker() {
  const leds = useStore((s) => s.leds)
  const selection = useStore((s) => s.selection)
  return (
    <>
      {selection.map((i) => {
        const p = leds[i]
        if (!p) return null
        return (
          <mesh key={i} position={[p.x, p.y, p.z]}>
            <sphereGeometry args={[0.5, 20, 20]} />
            <meshBasicMaterial color="#ffffff" wireframe toneMapped={false} />
          </mesh>
        )
      })}
    </>
  )
}
