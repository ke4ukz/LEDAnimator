import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import type { Source } from '../project'
import { getSourceCanvas } from '../texture'
import { GradientPreview } from './GradientPreview'
import { PathOverlay } from './PathOverlay'

/**
 * The source texture + draggable sampling path for the selected track. Used
 * small in the Source panel, or large in the center when the gradient editor is
 * focused (so nodes/handles are easier to place precisely). A corner button
 * toggles that focus.
 */
export function TexturePreview({
  large = false,
  onHover,
}: {
  large?: boolean
  onHover?: (p: { u: number; v: number } | null) => void
}) {
  const project = useStore((s) => s.project)
  const selectedTrack = useStore((s) => s.selectedTrack)
  const toggleFocus = useStore((s) => s.toggleFocusGradient)

  const track = project.tracks.find((t) => t.id === selectedTrack)
  const source = project.sources.find((s) => s.id === track?.sourceId)

  if (!track || !source) {
    return <div className={`preview-wrap${large ? ' large' : ''} empty`}>Select a track.</div>
  }

  const res = large ? 512 : 224
  return (
    <div className={`preview-wrap${large ? ' large' : ''}`}>
      {source.kind === 'image' ? (
        <ImagePreview source={source} size={res} />
      ) : (
        <GradientPreview gradient={source.gradient} post={source.post} width={res} height={res} />
      )}
      <PathOverlay track={track} onHover={onHover} />
      {/* Only the small (sidebar) preview gets the enlarge button; enlarging it
          shrinks the 3D view. The large one is collapsed from the 3D preview. */}
      {!large && (
        <button className="preview-focus-btn" onClick={toggleFocus} title="Enlarge the gradient editor">
          ⤢
        </button>
      )}
    </div>
  )
}

/** Draws an image source's (post-processed) texture, redrawing when its async
 *  decode completes (signalled by textureVersion). */
function ImagePreview({ source, size }: { source: Source; size: number }) {
  const version = useStore((s) => s.textureVersion)
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size, size)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(getSourceCanvas(source), 0, 0, size, size)
  }, [source, size, version])
  return <canvas ref={ref} width={size} height={size} className="grad-preview" />
}
