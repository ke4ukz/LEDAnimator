import { useStore } from '../store'
import { GradientPreview } from './GradientPreview'
import { PathOverlay } from './PathOverlay'

/**
 * The gradient texture + draggable sampling path for the selected track. Used
 * small in the Source panel, or large in the center when the gradient editor is
 * focused (so nodes/handles are easier to place precisely). A corner button
 * toggles that focus.
 */
export function TexturePreview({ large = false }: { large?: boolean }) {
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
      <GradientPreview gradient={source.gradient} post={source.post} width={res} height={res} />
      <PathOverlay track={track} />
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
