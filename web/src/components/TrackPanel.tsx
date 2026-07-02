import { useStore } from '../store'

/** Lists tracks with select/delete, plus an Add Track button. */
export function TrackPanel() {
  const tracks = useStore((s) => s.project.tracks)
  const assignments = useStore((s) => s.project.assignments)
  const selected = useStore((s) => s.selectedTrack)
  const selectTrack = useStore((s) => s.selectTrack)
  const addTrack = useStore((s) => s.addTrack)
  const deleteTrack = useStore((s) => s.deleteTrack)

  return (
    <div className="track-panel">
      <ul className="track-list">
        {tracks.map((t) => {
          const count = assignments.filter((id) => id === t.id).length
          return (
            <li
              key={t.id}
              className={t.id === selected ? 'sel' : ''}
              onClick={() => selectTrack(t.id)}
            >
              <span className="dot" />
              <span className="t-name">{t.name}</span>
              <span className="muted">{count} LEDs</span>
              <button
                className="x"
                title="Delete track"
                disabled={tracks.length <= 1}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteTrack(t.id)
                }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <button className="btn add-track" onClick={addTrack}>+ Add track</button>
    </div>
  )
}
