import { create } from 'zustand'
import type { LedPosition, Raster } from './types'
import { ringArrangement } from './demo'
import type { Gradient } from './gradient'
import { defaultGradient } from './presets'
import {
  type Automation,
  type AutoParam,
  type Project,
  type Source,
  type Track,
  defaultLinePath,
  defaultProject,
  newId,
} from './project'
import { bakeProject } from './bake'

interface AppState {
  leds: LedPosition[]
  project: Project
  raster: Raster
  frame: number
  playing: boolean
  selectedLed: number | null
  selectedTrack: string | null

  // Track / source editing (all re-bake the raster).
  updateGradient: (g: Gradient) => void
  addTrack: () => void
  deleteTrack: (id: string) => void
  updateTrack: (id: string, patch: Partial<Track>) => void
  /** Set (or clear, when auto is null) an automation curve for a track param. */
  setAutomation: (trackId: string, param: AutoParam, auto: Automation | null) => void
  assignLed: (led: number, trackId: string) => void

  selectTrack: (id: string | null) => void
  selectLed: (i: number | null) => void

  play: () => void
  pause: () => void
  togglePlay: () => void
  setFrame: (frame: number) => void
  advance: (n: number) => void
}

const DEMO_LEDS = 24
const demoLeds = ringArrangement(DEMO_LEDS)
const initialProject = defaultProject(DEMO_LEDS)

export const useStore = create<AppState>((set, get) => {
  /** Re-bake the raster from the current project, preserving frames/fps. */
  const rebake = (project: Project): Raster => {
    const { leds, raster } = get()
    return bakeProject(project, leds.length, raster.numFrames, raster.fps)
  }
  const commit = (project: Project) => set({ project, raster: rebake(project) })

  return {
    leds: demoLeds,
    project: initialProject,
    raster: bakeProject(initialProject, DEMO_LEDS),
    frame: 0,
    playing: true,
    selectedLed: 0,
    selectedTrack: initialProject.tracks[0]?.id ?? null,

    updateGradient: (g) => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s) =>
        s.id === track.sourceId ? { ...s, gradient: g } : s,
      )
      commit({ ...project, sources })
    },

    addTrack: () => {
      const { project } = get()
      const source: Source = {
        id: newId('src'),
        name: `Source ${project.sources.length + 1}`,
        kind: 'gradient',
        gradient: defaultGradient(),
      }
      const track: Track = {
        id: newId('trk'),
        name: `Track ${project.tracks.length + 1}`,
        sourceId: source.id,
        path: defaultLinePath(),
        speed: 1,
        offset: 0,
        chase: 0,
      }
      const next = {
        ...project,
        sources: [...project.sources, source],
        tracks: [...project.tracks, track],
      }
      set({ selectedTrack: track.id })
      commit(next)
    },

    deleteTrack: (id) => {
      const { project } = get()
      if (project.tracks.length <= 1) return // keep at least one
      const tracks = project.tracks.filter((t) => t.id !== id)
      const removed = project.tracks.find((t) => t.id === id)
      const fallback = tracks[0].id
      // Drop the track's now-orphaned source and reassign its LEDs.
      const sources = project.sources.filter((s) => s.id !== removed?.sourceId)
      const assignments = project.assignments.map((tid) => (tid === id ? fallback : tid))
      set((st) => ({ selectedTrack: st.selectedTrack === id ? fallback : st.selectedTrack }))
      commit({ sources, tracks, assignments })
    },

    updateTrack: (id, patch) => {
      const { project } = get()
      const tracks = project.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t))
      commit({ ...project, tracks })
    },

    setAutomation: (trackId, param, auto) => {
      const { project } = get()
      const tracks = project.tracks.map((t) => {
        if (t.id !== trackId) return t
        const automations = { ...t.automations }
        if (auto) automations[param] = auto
        else delete automations[param]
        return { ...t, automations }
      })
      commit({ ...project, tracks })
    },

    assignLed: (led, trackId) => {
      const { project } = get()
      const assignments = project.assignments.slice()
      assignments[led] = trackId
      commit({ ...project, assignments })
    },

    selectTrack: (id) => set({ selectedTrack: id }),
    selectLed: (i) => set({ selectedLed: i }),

    play: () => set({ playing: true }),
    pause: () => set({ playing: false }),
    togglePlay: () => set((s) => ({ playing: !s.playing })),
    setFrame: (frame) => set({ frame }),
    advance: (n) => {
      const { frame, raster } = get()
      const next = frame + n
      set({
        frame: raster.loop
          ? ((next % raster.numFrames) + raster.numFrames) % raster.numFrames
          : Math.max(0, Math.min(raster.numFrames - 1, next)),
      })
    },
  }
})
