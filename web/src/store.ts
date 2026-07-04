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
  emptyProject,
  newId,
  reserveIds,
} from './project'
import { reserveStopIds } from './gradient'
import { bakeProject } from './bake'
import type { ProjectFile } from './export/projectFile'
import { loadSavedProjectFile, loadSavedDirty, saveProjectFile, clearSavedProject } from './persistence'
import { saveProjectToLibrary, listLibrary } from './export/library'

interface AppState {
  leds: LedPosition[]
  project: Project
  projectId: string
  projectName: string
  /** The name this project has in the library (null = not saved there yet).
   * Lets Save detect an in-place rename and confirm overwrite vs. Save As. */
  savedName: string | null
  /** Unsaved changes since the last Save / Open / New. */
  dirty: boolean
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
  /** Active viewport tool. In 'renumber', a click reassigns chain order. */
  tool: 'select' | 'renumber'
  /** The chain number the renumber tool assigns on the next click. */
  renumberNext: number
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
  /** Blackout: force these LEDs' output to black (kept in the chain + order). */
  setLedDisabled: (indices: number[], value: boolean) => void
  /** Exclude/include these LEDs from the physical chain + export stream. */
  setLedUnassigned: (indices: number[], value: boolean) => void
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
  /** Enter the renumber tool, assigning consecutive numbers from `start`. */
  startRenumber: (start: number) => void
  /** Assign the next number to the LED at `index` (moves it there), then advance. */
  renumberAt: (index: number) => void
  /** Leave the renumber tool. */
  endRenumber: () => void
  setSelection: (indices: number[]) => void
  clearSelection: () => void

  /** Serialize the editable project state for saving. */
  getProjectFile: () => ProjectFile
  /** Replace the whole editable state from a loaded project (re-bakes). */
  loadProject: (file: ProjectFile, opts?: { dirty?: boolean }) => void
  /** Reset to a fresh empty project. */
  newProject: () => void
  /** Discard the current project unsaved and reset to a blank default (used after deleting the active project). */
  blankSlate: () => void
  /** Rename the current project. */
  renameProject: (name: string) => void
  /** Write the current project to the library (explicit save). */
  saveProject: () => void
  /** Save the current work as a new library project with the given name. */
  saveProjectAs: (name: string) => void

  /** Change the frame rate, keeping the loop length (re-bakes at new resolution). */
  setFps: (fps: number) => void
  /** Change the loop length in seconds, keeping the fps (re-bakes). */
  setDuration: (seconds: number) => void

  play: () => void
  pause: () => void
  togglePlay: () => void
  setFrame: (frame: number) => void
  advance: (n: number) => void
}

const DEMO_LEDS = 24

/** Advance id counters past a project's ids (loading, so new ids don't collide). */
function reserveProjectIds(project: Project) {
  const ids: string[] = []
  for (const s of project.sources) ids.push(s.id)
  for (const t of project.tracks) {
    ids.push(t.id)
    if (t.automations) {
      for (const auto of Object.values(t.automations)) {
        if (auto) for (const k of auto.keys) ids.push(k.id)
      }
    }
  }
  reserveIds(ids)
  const stopIds: string[] = []
  for (const s of project.sources) {
    const g = s.gradient
    if ('stops' in g) for (const st of g.stops) stopIds.push(st.id)
  }
  reserveStopIds(stopIds)
}

interface Init {
  leds: LedPosition[]
  project: Project
  projectId: string
  projectName: string
  dirty: boolean
  raster: Raster
  selectedTrack: string | null
  ledScale: number
  ledShape: 'sphere' | 'cube'
  showLabels: boolean
}

// True when startup found no last-open project — the bootstrap then seeds the
// ring demo only if the library is also empty (a truly first-ever run).
let wasEmptyStart = false

/** Startup state: the autosaved project if present, else an empty project. */
function initialState(): Init {
  const saved = loadSavedProjectFile()
  if (saved) {
    const project: Project = { sources: saved.sources, tracks: saved.tracks, assignments: saved.assignments }
    reserveProjectIds(project)
    return {
      leds: saved.leds,
      project,
      projectId: saved.id,
      projectName: saved.name,
      dirty: loadSavedDirty(),
      raster: bakeProject(project, saved.leds.length, saved.numFrames, saved.fps, saved.leds),
      selectedTrack: saved.tracks[0]?.id ?? null,
      ledScale: saved.display?.ledScale ?? 1,
      ledShape: saved.display?.ledShape ?? 'cube',
      showLabels: saved.display?.showLabels ?? false,
    }
  }
  wasEmptyStart = true
  const project = emptyProject()
  return {
    leds: [],
    project,
    projectId: crypto.randomUUID(),
    projectName: 'Untitled',
    dirty: false,
    raster: bakeProject(project, 0),
    selectedTrack: null,
    ledScale: 1,
    ledShape: 'cube',
    showLabels: false,
  }
}

const init = initialState()

// blankSlate sets this so the discarded project isn't written to the recovery copy.
let suppressAutosave = false
// True while an action makes a programmatic (non-user) editable change, so the
// autosave subscription doesn't mark the project dirty for loads/new/save-as.
let programmatic = false

export const useStore = create<AppState>((set, get) => {
  /** Re-bake the raster from the current project, preserving frames/fps. */
  const rebake = (project: Project): Raster => {
    const { leds, raster } = get()
    return bakeProject(project, leds.length, raster.numFrames, raster.fps, leds)
  }
  const commit = (project: Project) => set({ project, raster: rebake(project) })
  // A programmatic (non-user) editable change — the subscription won't mark it dirty.
  const setP = (partial: Partial<AppState>) => {
    programmatic = true
    set(partial)
    programmatic = false
  }

  return {
    leds: init.leds,
    project: init.project,
    projectId: init.projectId,
    projectName: init.projectName,
    // A recovered project is treated as saved-under-its-current-name; a truly
    // empty start isn't in the library yet.
    savedName: wasEmptyStart ? null : init.projectName,
    dirty: init.dirty,
    raster: init.raster,
    frame: 0,
    playing: true,
    selection: init.leds.length ? [0] : [],
    selectionAnchor: init.leds.length ? 0 : null,
    selectedTrack: init.selectedTrack,
    ghost: null,
    tool: 'select',
    renumberNext: 0,
    ledScale: init.ledScale,
    ledShape: init.ledShape,
    showLabels: init.showLabels,

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
      // The first track claims all existing LEDs so they actually light up;
      // later tracks start empty (assign LEDs to them manually). Without this,
      // LEDs added before any track stay unassigned ('') and bake to black.
      const first = project.tracks.length === 0
      const next = {
        ...project,
        sources: [...project.sources, source],
        tracks: [...project.tracks, track],
        assignments: first ? project.assignments.map(() => track.id) : project.assignments,
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

    setLedDisabled: (indices, value) => {
      const { leds, project, raster } = get()
      const set2 = new Set(indices)
      const newLeds = leds.map((p, i) => (set2.has(i) ? { ...p, disabled: value } : p))
      set({ leds: newLeds, raster: bakeProject(project, newLeds.length, raster.numFrames, raster.fps, newLeds) })
    },

    setLedUnassigned: (indices, value) => {
      const { leds, project, raster } = get()
      const set2 = new Set(indices)
      const newLeds = leds.map((p, i) => (set2.has(i) ? { ...p, unassigned: value } : p))
      set({ leds: newLeds, raster: bakeProject(project, newLeds.length, raster.numFrames, raster.fps, newLeds) })
    },

    addLeds: (newLeds) => {
      const { leds, project, raster } = get()
      const fallback = project.tracks[0]?.id ?? ''
      const allLeds = [...leds, ...newLeds]
      const assignments = [...project.assignments, ...newLeds.map(() => fallback)]
      const next = { ...project, assignments }
      set({ leds: allLeds, project: next, raster: bakeProject(next, allLeds.length, raster.numFrames, raster.fps, allLeds) })
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
        raster: bakeProject(next, newLeds.length, raster.numFrames, raster.fps, newLeds),
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
        raster: bakeProject(next, newLeds.length, raster.numFrames, raster.fps, newLeds),
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

    // Turn on number labels so you can see what you're assigning.
    startRenumber: (start) => set({ tool: 'renumber', renumberNext: Math.max(0, Math.floor(start) || 0), showLabels: true }),
    endRenumber: () => set({ tool: 'select' }),
    renumberAt: (index) => {
      const { leds, renumberNext } = get()
      const to = Math.max(0, Math.min(leds.length - 1, renumberNext))
      // moveLedTo reorders leds + assignments (array index = chain position),
      // re-bakes, and remaps selection; then advance to the next number.
      get().moveLedTo(index, to)
      set({ renumberNext: Math.min(to + 1, leds.length - 1), selection: [to] })
    },

    getProjectFile: () => {
      const s = get()
      return {
        format: 'led-animator-project',
        version: 1,
        id: s.projectId,
        name: s.projectName,
        fps: s.raster.fps,
        numFrames: s.raster.numFrames,
        leds: s.leds,
        sources: s.project.sources,
        tracks: s.project.tracks,
        assignments: s.project.assignments,
        display: { ledScale: s.ledScale, ledShape: s.ledShape, showLabels: s.showLabels },
      }
    },

    loadProject: (f, opts) => {
      const project: Project = { sources: f.sources, tracks: f.tracks, assignments: f.assignments }
      // Advance id counters past loaded ids so new items can't collide.
      const projIds: string[] = []
      for (const src of f.sources) projIds.push(src.id)
      for (const t of f.tracks) {
        projIds.push(t.id)
        if (t.automations) {
          for (const auto of Object.values(t.automations)) {
            if (auto) for (const k of auto.keys) projIds.push(k.id)
          }
        }
      }
      reserveIds(projIds)
      const stopIds: string[] = []
      for (const src of f.sources) {
        const g = src.gradient
        if ('stops' in g) for (const st of g.stops) stopIds.push(st.id)
      }
      reserveStopIds(stopIds)

      setP({
        leds: f.leds,
        project,
        projectId: f.id,
        projectName: f.name,
        savedName: f.name,
        dirty: opts?.dirty ?? false,
        ledScale: f.display?.ledScale ?? 1,
        ledShape: f.display?.ledShape ?? 'cube',
        showLabels: f.display?.showLabels ?? false,
        selection: [],
        selectionAnchor: null,
        selectedTrack: f.tracks[0]?.id ?? null,
        ghost: null,
        frame: 0,
        raster: bakeProject(project, f.leds.length, f.numFrames, f.fps, f.leds),
      })
    },

    newProject: () => {
      const project = emptyProject()
      setP({
        leds: [],
        project,
        projectId: crypto.randomUUID(),
        projectName: 'Untitled',
        savedName: null,
        dirty: false,
        raster: bakeProject(project, 0),
        frame: 0,
        selection: [],
        selectionAnchor: null,
        selectedTrack: null,
        ghost: null,
        ledScale: 1,
        ledShape: 'cube',
        showLabels: false,
      })
    },

    blankSlate: () => {
      // No save — skip the recovery write and clear it (nothing persisted until
      // the user edits and saves).
      suppressAutosave = true
      clearSavedProject()
      const project = emptyProject()
      setP({
        leds: [],
        project,
        projectId: crypto.randomUUID(),
        projectName: 'Untitled',
        savedName: null,
        dirty: false,
        raster: bakeProject(project, 0),
        frame: 0,
        selection: [],
        selectionAnchor: null,
        selectedTrack: null,
        ghost: null,
        ledScale: 1,
        ledShape: 'cube',
        showLabels: false,
      })
    },

    renameProject: (name) => set({ projectName: name }),

    saveProject: () => {
      const file = get().getProjectFile()
      saveProjectToLibrary(file)
      // This project now lives in the library under its current name.
      set({ dirty: false, savedName: file.name })
      saveProjectFile(file, false) // keep the recovery copy in sync (now clean)
    },

    saveProjectAs: (name) => {
      // Branch the current work off as a new library project, leaving the
      // original's saved copy untouched.
      const finalName = name.trim() || 'Untitled'
      setP({ projectId: crypto.randomUUID(), projectName: finalName, savedName: finalName, dirty: false })
      const file = get().getProjectFile()
      saveProjectToLibrary(file)
      saveProjectFile(file, false)
    },

    setFps: (fps) => {
      const { project, leds, raster, frame } = get()
      fps = Math.max(1, Math.min(240, Math.round(fps)))
      const duration = raster.numFrames / raster.fps
      const numFrames = Math.max(1, Math.round(duration * fps))
      set({ raster: bakeProject(project, leds.length, numFrames, fps, leds), frame: Math.min(frame, numFrames - 1) })
    },
    setDuration: (seconds) => {
      const { project, leds, raster, frame } = get()
      seconds = Math.max(0.05, seconds)
      const numFrames = Math.max(1, Math.round(seconds * raster.fps))
      set({ raster: bakeProject(project, leds.length, numFrames, raster.fps, leds), frame: Math.min(frame, numFrames - 1) })
    },

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

// Autosave the project (debounced) whenever the editable state changes. Frame
// ticks and selection don't touch these slices, so playback doesn't trigger it.
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, prev) => {
  const editable =
    state.leds !== prev.leds ||
    state.project !== prev.project ||
    state.raster !== prev.raster ||
    state.ledScale !== prev.ledScale ||
    state.ledShape !== prev.ledShape ||
    state.showLabels !== prev.showLabels ||
    state.projectName !== prev.projectName
  if (!editable) return

  // A genuine user edit marks the project dirty (programmatic loads/new don't).
  if (!programmatic && !state.dirty) useStore.setState({ dirty: true })

  // Recovery only — the library changes on explicit Save, never here. blankSlate
  // cleared the recovery copy and wants nothing written.
  if (suppressAutosave) {
    suppressAutosave = false
    clearTimeout(saveTimer)
    return
  }
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const s = useStore.getState()
    saveProjectFile(s.getProjectFile(), s.dirty)
  }, 800)
})

// Truly first-ever run (no last-open AND no library) → seed the ring demo so
// there's something to look at. If a library exists, the empty start stands
// (the user can Open… their projects). Guarded so it can't clobber quick edits.
if (wasEmptyStart) {
  listLibrary().then((entries) => {
    if (entries.length > 0) return
    const s = useStore.getState()
    if (s.leds.length === 0 && s.project.tracks.length === 0 && s.project.sources.length === 0) {
      const leds = ringArrangement(DEMO_LEDS)
      const project = defaultProject(DEMO_LEDS)
      programmatic = true
      useStore.setState({
        leds,
        project,
        raster: bakeProject(project, DEMO_LEDS),
        selection: [0],
        selectionAnchor: 0,
        selectedTrack: project.tracks[0]?.id ?? null,
      })
      programmatic = false
    }
  })
}
