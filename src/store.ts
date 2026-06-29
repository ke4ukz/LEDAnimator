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
  /** Selected LED indices (multi-select). */
  selection: number[]
  /** Anchor index for range (Shift) selection. */
  selectionAnchor: number | null
  selectedTrack: string | null
  /** Preview LEDs for a pending "add shape" (rendered as ghosts). */
  ghost: LedPosition[] | null
  // Display settings.
  ledScale: number
  ledShape: 'sphere' | 'cube'
  showLabels: boolean

  // Track / source editing (all re-bake the raster).
  updateGradient: (g: Gradient) => void
  addTrack: () => void
  deleteTrack: (id: string) => void
  updateTrack: (id: string, patch: Partial<Track>) => void
  /** Set (or clear, when auto is null) an automation curve for a track param. */
  setAutomation: (trackId: string, param: AutoParam, auto: Automation | null) => void
  assignLed: (led: number, trackId: string) => void
  assignLeds: (leds: number[], trackId: string) => void
  /** Patch position fields on the given LED indices (does not re-bake — position
   *  doesn't affect baked colors). */
  updateLeds: (indices: number[], patch: Partial<LedPosition>) => void
  /** Append LEDs to the arrangement (assigned to the first track; re-bakes). */
  addLeds: (leds: LedPosition[]) => void
  /** Remove LEDs by index (compacts assignments, remaps selection; re-bakes). */
  deleteLeds: (indices: number[]) => void
  /** Move LED from one index to another (reorders index + assignment; re-bakes). */
  moveLedTo: (from: number, to: number) => void
  setGhost: (leds: LedPosition[] | null) => void

  setLedScale: (v: number) => void
  setLedShape: (s: 'sphere' | 'cube') => void
  setShowLabels: (b: boolean) => void

  selectTrack: (id: string | null) => void
  /** replace = set to [i]; toggle = add/remove i; range = i…anchor inclusive. */
  selectLed: (i: number, mode?: 'replace' | 'toggle' | 'range') => void
  setSelection: (indices: number[]) => void
  clearSelection: () => void

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
    selection: [0],
    selectionAnchor: 0,
    selectedTrack: initialProject.tracks[0]?.id ?? null,
    ghost: null,
    ledScale: 1,
    ledShape: 'cube',
    showLabels: false,

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

    assignLeds: (leds, trackId) => {
      const { project } = get()
      const set2 = new Set(leds)
      const assignments = project.assignments.map((tid, i) => (set2.has(i) ? trackId : tid))
      commit({ ...project, assignments })
    },

    updateLeds: (indices, patch) => {
      const set2 = new Set(indices)
      set((s) => ({ leds: s.leds.map((p, i) => (set2.has(i) ? { ...p, ...patch } : p)) }))
    },

    addLeds: (newLeds) => {
      const { leds, project, raster } = get()
      const fallback = project.tracks[0]?.id ?? ''
      const allLeds = [...leds, ...newLeds]
      const assignments = [...project.assignments, ...newLeds.map(() => fallback)]
      const next = { ...project, assignments }
      set({ leds: allLeds, project: next, raster: bakeProject(next, allLeds.length, raster.numFrames, raster.fps) })
    },

    deleteLeds: (indices) => {
      const del = new Set(indices)
      if (del.size === 0) return
      const { leds, project, raster, selection } = get()
      const keep = leds.map((_, i) => i).filter((i) => !del.has(i))
      const newLeds = keep.map((i) => leds[i])
      const assignments = keep.map((i) => project.assignments[i])
      const remap = new Map(keep.map((oldI, newI) => [oldI, newI]))
      const newSelection = selection.filter((i) => remap.has(i)).map((i) => remap.get(i)!)
      const next = { ...project, assignments }
      set({
        leds: newLeds,
        project: next,
        selection: newSelection,
        raster: bakeProject(next, newLeds.length, raster.numFrames, raster.fps),
      })
    },

    moveLedTo: (from, to) => {
      const { leds, project, raster, selection } = get()
      to = Math.max(0, Math.min(leds.length - 1, to))
      if (to === from || from < 0 || from >= leds.length) return
      const newLeds = leds.slice()
      const [m] = newLeds.splice(from, 1)
      newLeds.splice(to, 0, m)
      const assignments = project.assignments.slice()
      const [am] = assignments.splice(from, 1)
      assignments.splice(to, 0, am)
      // Remap old indices → new after the move.
      const remap = (old: number) => {
        if (old === from) return to
        if (from < to) return old > from && old <= to ? old - 1 : old
        return old >= to && old < from ? old + 1 : old
      }
      const next = { ...project, assignments }
      set({
        leds: newLeds,
        project: next,
        selection: selection.map(remap),
        raster: bakeProject(next, newLeds.length, raster.numFrames, raster.fps),
      })
    },

    setGhost: (leds) => set({ ghost: leds }),

    setLedScale: (v) => set({ ledScale: v }),
    setLedShape: (s) => set({ ledShape: s }),
    setShowLabels: (b) => set({ showLabels: b }),

    selectTrack: (id) => set({ selectedTrack: id }),
    selectLed: (i, mode = 'replace') =>
      set((s) => {
        if (mode === 'range') {
          const anchor = s.selectionAnchor ?? i
          const lo = Math.min(anchor, i)
          const hi = Math.max(anchor, i)
          const range: number[] = []
          for (let k = lo; k <= hi; k++) range.push(k)
          return { selection: range }
        }
        if (mode === 'toggle') {
          const has = s.selection.includes(i)
          return {
            selection: has ? s.selection.filter((x) => x !== i) : [...s.selection, i],
            selectionAnchor: i,
          }
        }
        return { selection: [i], selectionAnchor: i }
      }),
    setSelection: (indices) => set({ selection: indices }),
    clearSelection: () => set({ selection: [] }),

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
