import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, TransformControls } from '@react-three/drei'
import { Color, type InstancedMesh, Object3D, SRGBColorSpace, Vector3 } from 'three'
import { useStore } from '../store'
import { type LedPosition, sampleRaster } from '../types'

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
        // The active tool decides what a click does.
        const { tool, renumberAt, animAssignAt, selectDeviceOf } = useStore.getState()
        // Any modifier means "toggle in/out"; unmodified means "replace". Alt
        // scopes the click to the whole device instead of the single LED.
        const toggle = e.shiftKey || e.metaKey || e.ctrlKey
        if (tool === 'renumber') renumberAt(e.instanceId)
        else if (tool === 'animassign') animAssignAt(e.instanceId)
        else if (e.altKey) selectDeviceOf(e.instanceId, toggle ? 'toggle' : 'replace')
        else selectLed(e.instanceId, toggle ? 'toggle' : 'replace')
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
  const labelMode = useStore((s) => s.labelMode)
  const tool = useStore((s) => s.tool)
  // The active assign tool overrides the display choice so you always see what
  // you're assigning; otherwise follow the Numbers dropdown.
  const mode = tool === 'renumber' ? 'chain' : tool === 'animassign' ? 'anim' : labelMode
  if (mode === 'none') return null
  let n = -1
  return (
    <>
      {leds.map((p, i) => {
        if (p.unassigned) return null
        n += 1
        const label = mode === 'anim' ? p.animIndex ?? n : mode === 'device' ? p.device ?? 0 : n
        return (
          <Html key={i} position={[p.x, p.y, p.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div className={`led-label ${mode}`}>{label}</div>
          </Html>
        )
      })}
    </>
  )
}

/**
 * A three-axis translate gizmo on the current selection. Because the LEDs are a
 * single InstancedMesh (a gizmo can't attach to one instance), it drives an
 * invisible proxy Object3D parked at the selection's centroid, and applies the
 * proxy's drag delta to every selected LED via `offsetLeds` (no re-bake).
 * Only rendered when the Move tool is on and something is selected.
 */
export function MoveGizmo() {
  const selection = useStore((s) => s.selection)
  const leds = useStore((s) => s.leds)
  const offsetLeds = useStore((s) => s.offsetLeds)
  const proxy = useMemo(() => new Object3D(), [])
  const dragging = useRef(false)
  // Set when a drag is cancelled (Escape): swallow further gizmo motion until
  // the mouse is released, and keep the gizmo pinned at where the drag began.
  const aborted = useRef(false)
  const last = useRef(new Vector3())
  const startPos = useRef(new Vector3())
  // Snapshot of the leds array at drag start, to restore exactly on cancel.
  const startLeds = useRef<LedPosition[] | null>(null)

  const validSel = selection.filter((i) => leds[i])

  // Park the gizmo at the selection's centroid when not mid-drag. During a drag,
  // `leds` changes each tick but we hold position (the gizmo is being dragged).
  // Layout effect so it's centered before paint (no one-frame flash at origin).
  useLayoutEffect(() => {
    if (dragging.current || validSel.length === 0) return
    const c = new Vector3()
    for (const i of validSel) c.add(new Vector3(leds[i].x, leds[i].y, leds[i].z))
    proxy.position.copy(c.multiplyScalar(1 / validSel.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, leds, proxy])

  // Escape mid-drag cancels: restore the snapshot and hold until mouse release.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragging.current || aborted.current) return
      aborted.current = true
      if (startLeds.current) useStore.setState({ leds: startLeds.current })
      proxy.position.copy(startPos.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [proxy])

  if (validSel.length === 0) return null

  return (
    <>
      <primitive object={proxy} />
      <TransformControls
        object={proxy}
        mode="translate"
        onMouseDown={() => {
          dragging.current = true
          aborted.current = false
          startPos.current.copy(proxy.position)
          last.current.copy(proxy.position)
          startLeds.current = useStore.getState().leds
        }}
        onMouseUp={() => {
          dragging.current = false
          aborted.current = false
          startLeds.current = null
        }}
        onObjectChange={() => {
          if (!dragging.current) return
          // After a cancel, keep the gizmo pinned and apply nothing more.
          if (aborted.current) {
            proxy.position.copy(startPos.current)
            return
          }
          const p = proxy.position
          const dx = p.x - last.current.x
          const dy = p.y - last.current.y
          const dz = p.z - last.current.z
          if (dx || dy || dz) {
            // Read the live selection so a stale closure can't misfire.
            offsetLeds(useStore.getState().selection, { x: dx, y: dy, z: dz })
            last.current.copy(p)
          }
        }}
      />
    </>
  )
}
