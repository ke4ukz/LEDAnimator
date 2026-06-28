import type { LedPosition } from './types'

/** A ring of LEDs lying in the XZ plane, centered at the origin. */
export function ringArrangement(count: number, radius = 4): LedPosition[] {
  const leds: LedPosition[] = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    leds.push({ x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius })
  }
  return leds
}
