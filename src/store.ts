import { create } from 'zustand'
import type { LedPosition, Raster } from './types'
import { rainbowChaseRaster, ringArrangement } from './demo'

interface AppState {
  /** 3D positions of every LED. Index === LED index in the raster. */
  leds: LedPosition[]
  /** The baked animation currently loaded into the emulator. */
  raster: Raster
  /** Current frame index being displayed. */
  frame: number
  /** Whether the fixed-rate player is advancing frames. */
  playing: boolean

  play: () => void
  pause: () => void
  togglePlay: () => void
  setFrame: (frame: number) => void
  /** Advance by `n` frames (wrapping when the raster loops). */
  advance: (n: number) => void
}

const DEMO_LEDS = 24
const demoLeds = ringArrangement(DEMO_LEDS)
const demoRaster = rainbowChaseRaster(DEMO_LEDS)

export const useStore = create<AppState>((set, get) => ({
  leds: demoLeds,
  raster: demoRaster,
  frame: 0,
  playing: true,

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
