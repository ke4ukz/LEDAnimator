import type { LedPosition } from './types'

/** A ring of LEDs lying in the XY plane (Z-up), centered at the origin. */
export function ringArrangement(count: number, radius = 4): LedPosition[] {
  const leds: LedPosition[] = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    leds.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius, z: 0 })
  }
  return leds
}
