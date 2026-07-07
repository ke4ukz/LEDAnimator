import { create } from 'zustand'
import type { LedPosition, Raster } from './types'
import { ringArrangement } from './demo'
import type { Gradient } from './gradient'
import { defaultGradient } from './presets'
import {
  type Automation,
  type AutoParam,
  type LabelMode,
  type PostFx,
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
import { setTextureReadyListener } from './texture'
import type { DeviceDefaults, DeviceSettings, MultiDevice, ProjectFile } from './export/projectFile'

/** Shared pin/brightness applied to every device when `uniform` is on. */
type DeviceDefaultsState = { uniform: boolean; pin: number; brightness: number }
const initialDeviceDefaults = (d?: DeviceDefaults): DeviceDefaultsState => ({
  uniform: d?.uniform ?? true,
  pin: d?.pin ?? 0,
  brightness: d?.brightness ?? 1,
})

/** Installation-level sync settings for multi-device export (see MultiDevice).
 *  `leader` is a device id; if it isn't among the exported devices the dialog
 *  falls back to the lowest present one. */
type MultiDeviceState = { group: number; leader: number; autoElect: boolean; lossPolicy: number; startup: number }
const initialMultiDevice = (m?: MultiDevice): MultiDeviceState => ({
  group: m?.group ?? 0,
  leader: m?.leader ?? 0,
  autoElect: m?.autoElect ?? false,
  lossPolicy: m?.lossPolicy ?? 0,
  startup: m?.startup ?? 0,
})
import { loadSavedProjectFile, loadSavedDirty, loadSavedName, saveProjectFile, clearSavedProject, enforceStorageVersion } from './persistence'
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
  /** Program number for this pattern (the group's selection id; export filename
   *  prefix). Useful even single-device as a stable id among loaded programs. */
  program: number
  /** Per-device firmware settings (name / pin / brightness), keyed by device id. */
  deviceSettings: Record<number, DeviceSettings>
  /** Shared pin/brightness + the "set all devices at once" export toggle. */
  deviceDefaults: DeviceDefaultsState
  /** Installation-level sync settings (group / leader / on-loss) for export. */
  multiDevice: MultiDeviceState
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
  /** Active viewport tool. 'renumber' = clicks reassign wiring order;
   *  'animassign' = clicks assign the current animation index. */
  tool: 'select' | 'renumber' | 'animassign'
  /** The chain number the renumber tool assigns on the next click. */
  renumberNext: number
  /** The animation index the anim-assign tool stamps onto clicked LEDs. */
  animAssignValue: number
  /** When true, each anim-assign click auto-advances the index (sequential);
   *  when false, clicks share the current index (grouping). */
  animAssignAuto: boolean
  // Display settings.
  ledScale: number
  ledShape: 'sphere' | 'cube'
  /** Which number to billboard on each LED: none, wiring/chain #, or animation #.
   *  The renumber/anim-assign tools override this while active. */
  labelMode: LabelMode
  /** Show a dim ghost marker on the path where each LED currently samples. */
  showSamples: boolean
  /** Show the 3D translate gizmo on the selection (drag LEDs along X/Y/Z). */
  moveTool: boolean
  /** When true, the gradient texture is the big center editor and the 3D view
   *  is a small preview (for precise node/handle placement). */
  focusGradient: boolean
  /** Bumped when an async image texture finishes decoding, so views that draw
   *  image sources re-render once the real pixels exist. */
  textureVersion: number

  // Track / source editing (all re-bake the raster).
  updateGradient: (g: Gradient) => void
  /** Merge a patch into the selected track's source post-processing (adjustments). */
  updatePost: (patch: Partial<PostFx>) => void
  /** Turn the selected track's source into an image (from a data URL). */
  setSourceImage: (image: string, name?: string) => void
  /** Choose the background an image source's transparency flattens over. */
  setImageBg: (bg: 'white' | 'black') => void
  /** Turn the selected track's source back into a (default) gradient. */
  setSourceGradient: () => void
  addTrack: () => void
  /** Clone a track's settings + source (starts with no LEDs assigned). */
  duplicateTrack: (id: string) => void
  deleteTrack: (id: string) => void
  updateTrack: (id: string, patch: Partial<Track>) => void
  /** Set (or clear, when auto is null) an automation curve for a track param. */
  setAutomation: (trackId: string, param: AutoParam, auto: Automation | null) => void
  assignLed: (led: number, trackId: string) => void
  assignLeds: (leds: number[], trackId: string) => void
  /** Patch position fields on the given LED indices (does not re-bake — position
   *  doesn't affect baked colors). */
  updateLeds: (indices: number[], patch: Partial<LedPosition>) => void
  /** Add a per-axis delta to each LED's position (relative move; no re-bake). */
  offsetLeds: (indices: number[], delta: Partial<Pick<LedPosition, 'x' | 'y' | 'z'>>) => void
  /** Blackout: force these LEDs' output to black (kept in the chain + order). */
  setLedDisabled: (indices: number[], value: boolean) => void
  /** Exclude/include these LEDs from the physical chain + export stream. */
  setLedUnassigned: (indices: number[], value: boolean) => void
  /** Override the animation index for these LEDs (null clears → wiring default). */
  setLedAnimIndex: (indices: number[], value: number | null) => void
  /** Set which device renders these LEDs (0 = default single device). */
  setLedDevice: (indices: number[], value: number) => void
  /** Set the program number (export filename prefix). */
  setProgram: (n: number) => void
  /** Merge a patch into one device's firmware settings. */
  setDeviceSettings: (device: number, patch: Partial<DeviceSettings>) => void
  /** Merge a patch into the shared device defaults (uniform / pin / brightness). */
  setDeviceDefaults: (patch: Partial<DeviceDefaultsState>) => void
  setMultiDevice: (patch: Partial<MultiDeviceState>) => void
  /** Append LEDs to the arrangement (assigned to the first track; re-bakes). */
  addLeds: (leds: LedPosition[]) => void
  /** Remove LEDs by index (compacts assignments, remaps selection; re-bakes). */
  deleteLeds: (indices: number[]) => void
  /** Move LED from one index to another (reorders index + assignment; re-bakes). */
  moveLedTo: (from: number, to: number) => void
  setGhost: (leds: LedPosition[] | null) => void

  setLedScale: (v: number) => void
  setLedShape: (s: 'sphere' | 'cube') => void
  setLabelMode: (mode: LabelMode) => void
  setShowSamples: (b: boolean) => void
  setMoveTool: (v: boolean) => void
  toggleFocusGradient: () => void

  selectTrack: (id: string | null) => void
  /** replace = set to [i]; toggle = add/remove i; range = i…anchor inclusive. */
  selectLed: (i: number, mode?: 'replace' | 'toggle' | 'range') => void
  /** Select every LED sharing the given LED's device (Alt/Option-click).
   *  'replace' selects just that device; 'toggle' adds the whole device, or
   *  removes it if all of its LEDs are already selected. */
  selectDeviceOf: (led: number, mode?: 'replace' | 'toggle') => void
  /** Enter the renumber tool, assigning consecutive numbers from `start`. */
  startRenumber: (start: number) => void
  /** Assign the next number to the LED at `index` (moves it there), then advance. */
  renumberAt: (index: number) => void
  /** Leave the renumber tool. */
  endRenumber: () => void
  /** Enter the anim-assign tool, stamping animation index `start` on clicks. */
  startAnimAssign: (start: number) => void
  /** Stamp the current animation index onto the LED at `index` (no auto-advance). */
  animAssignAt: (index: number) => void
  /** Advance the stamped animation index (start a new group). */
  nextAnimAssign: () => void
  /** Toggle auto-advance (sequential vs. grouping) for the anim-assign tool. */
  setAnimAssignAuto: (value: boolean) => void
  /** Leave the anim-assign tool. */
  endAnimAssign: () => void
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
    if (s.kind !== 'gradient') continue
    if ('stops' in s.gradient) for (const st of s.gradient.stops) stopIds.push(st.id)
  }
  reserveStopIds(stopIds)
}

interface Init {
  leds: LedPosition[]
  project: Project
  projectId: string
  projectName: string
  dirty: boolean
  program: number
  deviceSettings: Record<number, DeviceSettings>
  deviceDefaults: DeviceDefaultsState
  multiDevice: MultiDeviceState
  raster: Raster
  selectedTrack: string | null
  ledScale: number
  ledShape: 'sphere' | 'cube'
  labelMode: LabelMode
}

/** Read a label mode from a saved display block, defaulting old files (which
 *  stored a boolean `showLabels`) to chain numbers / none. */
const labelModeFrom = (d?: { labelMode?: LabelMode; showLabels?: boolean }): LabelMode =>
  d?.labelMode ?? (d?.showLabels ? 'chain' : 'none')

// True when startup found no last-open project — the bootstrap then seeds the
// ring demo only if the library is also empty (a truly first-ever run).
let wasEmptyStart = false

/** Startup state: the autosaved project if present, else an empty project. */
function initialState(): Init {
  // Drop a stale working session after a system change, so old tweaks (e.g.
  // cranked Adjustments) don't bleed into a new build.
  enforceStorageVersion()
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
      program: saved.program ?? 1,
      deviceSettings: saved.devices ?? {},
      deviceDefaults: initialDeviceDefaults(saved.deviceDefaults),
      multiDevice: initialMultiDevice(saved.multiDevice),
      raster: bakeProject(project, saved.leds.length, saved.numFrames, saved.fps, saved.leds),
      selectedTrack: saved.tracks[0]?.id ?? null,
      ledScale: saved.display?.ledScale ?? 1,
      ledShape: saved.display?.ledShape ?? 'cube',
      labelMode: labelModeFrom(saved.display),
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
    program: 1,
    deviceSettings: {},
    deviceDefaults: initialDeviceDefaults(),
    multiDevice: initialMultiDevice(),
    raster: bakeProject(project, 0),
    selectedTrack: null,
    ledScale: 1,
    ledShape: 'cube',
    labelMode: 'none',
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

  // When an image source finishes decoding, re-bake (its pixels were black
  // placeholders until now) and bump the version so image views re-render. This
  // touches only derived state, so it doesn't mark the project dirty.
  setTextureReadyListener(() => {
    set((s) => ({ textureVersion: s.textureVersion + 1, raster: rebake(s.project) }))
  })

  return {
    leds: init.leds,
    project: init.project,
    projectId: init.projectId,
    projectName: init.projectName,
    // Restore the library name the recovered project was saved under (null if
    // it was never saved to the library, so a rename+Save won't falsely warn).
    savedName: wasEmptyStart ? null : loadSavedName(),
    dirty: init.dirty,
    program: init.program,
    deviceSettings: init.deviceSettings,
    deviceDefaults: init.deviceDefaults,
    multiDevice: init.multiDevice,
    raster: init.raster,
    frame: 0,
    playing: true,
    selection: init.leds.length ? [0] : [],
    selectionAnchor: init.leds.length ? 0 : null,
    selectedTrack: init.selectedTrack,
    ghost: null,
    tool: 'select',
    renumberNext: 0,
    animAssignValue: 0,
    animAssignAuto: false,
    ledScale: init.ledScale,
    ledShape: init.ledShape,
    labelMode: init.labelMode,
    showSamples: false,
    moveTool: false,
    focusGradient: false,
    textureVersion: 0,

    updateGradient: (g) => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s) =>
        s.id === track.sourceId && s.kind === 'gradient' ? { ...s, gradient: g } : s,
      )
      commit({ ...project, sources })
    },

    setSourceImage: (image, name) => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s): Source =>
        s.id === track.sourceId
          ? { id: s.id, name: name ?? s.name, kind: 'image', image, bg: 'white', post: s.post }
          : s,
      )
      commit({ ...project, sources })
    },

    setImageBg: (bg) => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s): Source =>
        s.id === track.sourceId && s.kind === 'image' ? { ...s, bg } : s,
      )
      commit({ ...project, sources })
    },

    setSourceGradient: () => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s): Source =>
        s.id === track.sourceId && s.kind !== 'gradient'
          ? { id: s.id, name: s.name, kind: 'gradient', gradient: defaultGradient(), post: s.post }
          : s,
      )
      commit({ ...project, sources })
    },

    updatePost: (patch) => {
      const { project, selectedTrack } = get()
      const track = project.tracks.find((t) => t.id === selectedTrack)
      if (!track) return
      const sources = project.sources.map((s) =>
        s.id === track.sourceId ? { ...s, post: { ...s.post, ...patch } } : s,
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
      // Smallest unused "Track N" (so a rename/duplicate doesn't leave a gap).
      const used = new Set(project.tracks.map((t) => t.name))
      let n = 1
      while (used.has(`Track ${n}`)) n++
      const track: Track = {
        id: newId('trk'),
        name: `Track ${n}`,
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

    duplicateTrack: (id) => {
      const { project } = get()
      const src = project.tracks.find((t) => t.id === id)
      if (!src) return
      const source = project.sources.find((s) => s.id === src.sourceId)
      // Clone the whole source (gradient or image + adjustments) so edits stay
      // independent; structuredClone handles either kind.
      const newSource: Source = source
        ? { ...structuredClone(source), id: newId('src'), name: `${source.name} copy` }
        : { id: newId('src'), name: 'Source', kind: 'gradient', gradient: defaultGradient() }
      // Clone the track's settings; it starts with no LEDs (assign them after).
      const newTrack: Track = {
        ...src,
        id: newId('trk'),
        name: `${src.name} copy`,
        sourceId: newSource.id,
        path: structuredClone(src.path),
        automations: src.automations ? structuredClone(src.automations) : undefined,
      }
      set({ selectedTrack: newTrack.id })
      commit({
        ...project,
        sources: [...project.sources, newSource],
        tracks: [...project.tracks, newTrack],
      })
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

    offsetLeds: (indices, delta) => {
      const set2 = new Set(indices)
      const { x = 0, y = 0, z = 0 } = delta
      set((s) => ({
        leds: s.leds.map((p, i) => (set2.has(i) ? { ...p, x: p.x + x, y: p.y + y, z: p.z + z } : p)),
      }))
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

    setLedAnimIndex: (indices, value) => {
      const { leds, project, raster } = get()
      const set2 = new Set(indices)
      const newLeds = leds.map((p, i) => {
        if (!set2.has(i)) return p
        const next = { ...p }
        if (value == null) delete next.animIndex // clear override → default (wiring rank)
        else next.animIndex = Math.max(0, Math.floor(value))
        return next
      })
      set({ leds: newLeds, raster: bakeProject(project, newLeds.length, raster.numFrames, raster.fps, newLeds) })
    },

    // Device id doesn't affect baked colors (only which slice an LED exports to),
    // so no re-bake — just update the leds (which marks the project dirty).
    setLedDevice: (indices, value) => {
      const set2 = new Set(indices)
      set((s) => ({
        leds: s.leds.map((p, i) => {
          if (!set2.has(i)) return p
          const next = { ...p }
          if (value <= 0) delete next.device // 0 = default single device
          else next.device = Math.floor(value)
          return next
        }),
      }))
    },

    setProgram: (n) => set({ program: Math.max(0, Math.min(255, Math.floor(n) || 0)) }),

    setDeviceSettings: (device, patch) =>
      set((s) => ({ deviceSettings: { ...s.deviceSettings, [device]: { ...s.deviceSettings[device], ...patch } } })),

    setDeviceDefaults: (patch) => set((s) => ({ deviceDefaults: { ...s.deviceDefaults, ...patch } })),

    setMultiDevice: (patch) => set((s) => ({ multiDevice: { ...s.multiDevice, ...patch } })),

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
    setLabelMode: (mode) => set({ labelMode: mode }),
    setShowSamples: (b) => set({ showSamples: b }),
    setMoveTool: (v) => set({ moveTool: v }),
    toggleFocusGradient: () => set((s) => ({ focusGradient: !s.focusGradient })),

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
    selectDeviceOf: (led, mode = 'replace') => {
      const { leds, selection } = get()
      const d = leds[led]?.device ?? 0
      const idxs = leds.map((p, i) => ((p.device ?? 0) === d ? i : -1)).filter((i) => i >= 0)
      if (mode === 'toggle') {
        const sel = new Set(selection)
        // Toggle the whole device as a unit: remove it if fully selected, else add it.
        if (idxs.every((i) => sel.has(i))) idxs.forEach((i) => sel.delete(i))
        else idxs.forEach((i) => sel.add(i))
        set({ selection: [...sel], selectionAnchor: led })
      } else {
        set({ selection: idxs, selectionAnchor: led })
      }
    },

    // The active tool forces the relevant labels on (see LedLabels).
    startRenumber: (start) => set({ tool: 'renumber', renumberNext: Math.max(0, Math.floor(start) || 0) }),
    endRenumber: () => set({ tool: 'select' }),
    renumberAt: (index) => {
      const { leds, renumberNext } = get()
      const to = Math.max(0, Math.min(leds.length - 1, renumberNext))
      // moveLedTo reorders leds + assignments (array index = chain position),
      // re-bakes, and remaps selection; then advance to the next number.
      get().moveLedTo(index, to)
      set({ renumberNext: Math.min(to + 1, leds.length - 1), selection: [to] })
    },

    startAnimAssign: (start) => set({ tool: 'animassign', animAssignValue: Math.max(0, Math.floor(start) || 0) }),
    endAnimAssign: () => set({ tool: 'select' }),
    nextAnimAssign: () => set((s) => ({ animAssignValue: s.animAssignValue + 1 })),
    setAnimAssignAuto: (value) => set({ animAssignAuto: value }),
    animAssignAt: (index) => {
      // Stamp the current value; repeats are allowed (that's how you group).
      // With auto-advance on, bump the index so the next click is sequential.
      const { animAssignValue, animAssignAuto } = get()
      get().setLedAnimIndex([index], animAssignValue)
      set({ selection: [index], ...(animAssignAuto ? { animAssignValue: animAssignValue + 1 } : {}) })
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
        program: s.program,
        devices: s.deviceSettings,
        deviceDefaults: s.deviceDefaults,
        multiDevice: s.multiDevice,
        display: { ledScale: s.ledScale, ledShape: s.ledShape, labelMode: s.labelMode },
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
        if (src.kind !== 'gradient') continue
        if ('stops' in src.gradient) for (const st of src.gradient.stops) stopIds.push(st.id)
      }
      reserveStopIds(stopIds)

      setP({
        leds: f.leds,
        project,
        projectId: f.id,
        projectName: f.name,
        savedName: f.name,
        dirty: opts?.dirty ?? false,
        program: f.program ?? 1,
        deviceSettings: f.devices ?? {},
        deviceDefaults: initialDeviceDefaults(f.deviceDefaults),
        multiDevice: initialMultiDevice(f.multiDevice),
        ledScale: f.display?.ledScale ?? 1,
        ledShape: f.display?.ledShape ?? 'cube',
        labelMode: labelModeFrom(f.display),
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
        program: 1,
        deviceSettings: {},
        deviceDefaults: initialDeviceDefaults(),
        multiDevice: initialMultiDevice(),
        raster: bakeProject(project, 0),
        frame: 0,
        selection: [],
        selectionAnchor: null,
        selectedTrack: null,
        ghost: null,
        ledScale: 1,
        ledShape: 'cube',
        labelMode: 'none',
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
        program: 1,
        deviceSettings: {},
        deviceDefaults: initialDeviceDefaults(),
        multiDevice: initialMultiDevice(),
        raster: bakeProject(project, 0),
        frame: 0,
        selection: [],
        selectionAnchor: null,
        selectedTrack: null,
        ghost: null,
        ledScale: 1,
        ledShape: 'cube',
        labelMode: 'none',
      })
    },

    renameProject: (name) => set({ projectName: name }),

    saveProject: () => {
      const file = get().getProjectFile()
      saveProjectToLibrary(file)
      // This project now lives in the library under its current name.
      set({ dirty: false, savedName: file.name })
      saveProjectFile(file, false, file.name) // keep the recovery copy in sync (now clean)
    },

    saveProjectAs: (name) => {
      // Branch the current work off as a new library project, leaving the
      // original's saved copy untouched.
      const finalName = name.trim() || 'Untitled'
      setP({ projectId: crypto.randomUUID(), projectName: finalName, savedName: finalName, dirty: false })
      const file = get().getProjectFile()
      saveProjectToLibrary(file)
      saveProjectFile(file, false, finalName)
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
    state.labelMode !== prev.labelMode ||
    state.projectName !== prev.projectName ||
    state.program !== prev.program ||
    state.deviceSettings !== prev.deviceSettings ||
    state.deviceDefaults !== prev.deviceDefaults
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
    saveProjectFile(s.getProjectFile(), s.dirty, s.savedName)
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
