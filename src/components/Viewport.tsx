import { Canvas } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei'
import { Leds } from './Leds'

/** The 3D simulation viewport: orbitable camera playing the baked animation. */
export function Viewport() {
  return (
    <Canvas camera={{ position: [0, 6, 11], fov: 50 }} dpr={[1, 2]}>
      <color attach="background" args={['#0b0d12']} />
      <gridHelper args={[20, 20, '#252b3b', '#161a24']} />
      <Leds />
      <OrbitControls makeDefault enableDamping />
      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={['#e0586b', '#7bd06a', '#5b8ff0']} labelColor="#cfd6e4" />
      </GizmoHelper>
    </Canvas>
  )
}
