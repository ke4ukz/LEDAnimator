import type { Raster } from '../types'

// Target device profiles. The limits are deliberate *estimates* used only to
// surface a soft "this may be too large" warning — the user can always export
// anyway (our guesses may be conservative).

export interface DeviceProfile {
  id: string
  name: string
  /** Approx. max LEDs (driver + per-frame RAM). */
  maxLeds: number
  /** Approx. budget for the pattern data (flash / filesystem), in bytes. */
  maxDataBytes: number
  notes: string
  /** Export targets implemented for this device (others are planned). */
  targets: ('rp2040-rust' | 'rp2350-rust')[]
}

export const DEVICES: DeviceProfile[] = [
  {
    id: 'rp2040',
    name: 'RP2040 (Pico / Pico W)',
    maxLeds: 2000,
    maxDataBytes: 800_000,
    notes: '264 KB RAM; ~848 KB on-flash filesystem (Pico W). WS2812 driven via PIO. Rust firmware.',
    targets: ['rp2040-rust'],
  },
  {
    id: 'rp2350',
    name: 'RP2350 (Pico 2 W)',
    maxLeds: 2000,
    maxDataBytes: 800_000,
    notes: '520 KB RAM; ~848 KB on-flash filesystem (Pico 2 W). WS2812 driven via PIO. Rust firmware.',
    targets: ['rp2350-rust'],
  },
  {
    id: 'atmega328',
    name: 'ATmega328 (Arduino Uno / Nano)',
    maxLeds: 300,
    maxDataBytes: 28_000,
    notes: '2 KB RAM, ~30 KB usable flash; pattern would be baked into PROGMEM. Export planned.',
    targets: [],
  },
  {
    id: 'pi',
    name: 'Raspberry Pi / Pi Zero',
    maxLeds: 100_000,
    maxDataBytes: 2_000_000_000,
    notes: 'Effectively unlimited for our purposes. Reuses the Python data format. Export planned.',
    targets: [],
  },
]

/** WS2812 refresh ceiling for a given LED count (~30 µs/LED + 50 µs reset). */
export function ws2812MaxFps(numLeds: number): number {
  return Math.floor(1_000_000 / (numLeds * 30 + 50))
}

const kb = (n: number) => `${(n / 1024).toFixed(n < 1024 * 10 ? 1 : 0)} KB`

/** Soft warnings if the project likely exceeds the device's estimated limits. */
export function checkLimits(device: DeviceProfile, raster: Raster, dataBytes: number): string[] {
  const w: string[] = []
  if (raster.numLeds > device.maxLeds) {
    w.push(`${raster.numLeds} LEDs exceeds the estimated ~${device.maxLeds}-LED limit.`)
  }
  if (dataBytes > device.maxDataBytes) {
    w.push(`Pattern data is ${kb(dataBytes)} — over the estimated ~${kb(device.maxDataBytes)} budget.`)
  }
  const ceil = ws2812MaxFps(raster.numLeds)
  if (raster.fps > ceil) {
    w.push(`${raster.fps} fps is above the WS2812 refresh ceiling (~${ceil} fps) for ${raster.numLeds} LEDs.`)
  }
  return w
}
