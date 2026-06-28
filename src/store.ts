import { create } from 'zustand'
import type { LedPosition, Raster } from './types'
import { ringArrangement } from './demo'
import { type Gradient, defaultGradient } from './gradient'
import { bakeGradientRaster } from './bake'

interface AppState {
  /** 3D positions of every LED. Index === LED index in the raster. */
  leds: LedPosition[]
  /** The active, non-destructive gradient source. */
  gradient: Gradient
  /** The baked animation currently loaded into the emulator. */
  raster: Raster
  /** Current frame index being displayed. */
  frame: number
  /** Whether the fixed-rate player is advancing frames. */
  playing: boolean
  /** Index of the LED selected in the list / inspector, if any. */
  selectedLed: number | null

  /** Replace the gradient and re-bake the raster (live, non-destructive). */
  setGradient: (g: Gradient) => void
  selectLed: (i: number | null) => void

  play: () => void
  pause: () => void
  togglePlay: () => void
  setFrame: (frame: number) => void
  /** Advance by `n` frames (wrapping when the raster loops). */
  advance: (n: number) => void
}

const DEMO_LEDS = 24
const demoLeds = ringArrangement(DEMO_LEDS)
const initialGradient = defaultGradient()

export const useStore = create<AppState>((set, get) => ({
  leds: demoLeds,
  gradient: initialGradient,
  raster: bakeGradientRaster(initialGradient, DEMO_LEDS),
  frame: 0,
  playing: true,
  selectedLed: 0,

  selectLed: (i) => set({ selectedLed: i }),

  setGradient: (g) => {
    const { leds, raster } = get()
    set({ gradient: g, raster: bakeGradientRaster(g, leds.length, raster.numFrames, raster.fps) })
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
}))
