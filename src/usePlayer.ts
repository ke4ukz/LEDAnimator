import { useEffect } from 'react'
import { useStore } from './store'

/**
 * The emulator's playback loop. Deliberately models the target firmware: a
 * single fixed-rate clock that advances whole frames at `1000 / raster.fps`.
 * No per-LED timing, no interpolation — just step the baked raster.
 *
 * Uses a wall-clock accumulator so playback stays at the right rate even when
 * the display refresh differs from the animation fps.
 */
export function usePlayer() {
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let acc = 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const { playing, raster, advance } = useStore.getState()
      const dt = now - last
      last = now
      if (!playing) {
        acc = 0
        return
      }
      const interval = 1000 / raster.fps
      acc += dt
      let steps = Math.floor(acc / interval)
      if (steps <= 0) return
      acc -= steps * interval
      // Guard against a huge catch-up after the tab was backgrounded.
      if (steps > raster.numFrames) steps = (steps % raster.numFrames) || 1
      advance(steps)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
}
