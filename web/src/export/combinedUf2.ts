import firmwareUrlRp2040 from '../assets/led-animator-rp2040.uf2?url'
import firmwareUrlRp2350 from '../assets/led-animator-rp2350.uf2?url'
import type { Raster } from '../types'
import { encodeRaster, type LedaMeta } from './format'
import { buildLittleFsImage } from './littlefs'
import { assembleCombinedUf2 } from './uf2'
import { FIRMWARE_RELEASES } from './firmwareRelease.generated'

/** UF2 targets that ship a one-drag combined image (firmware + littlefs). */
export type Uf2Target = 'rp2040' | 'rp2350'
const FIRMWARE_URL: Record<Uf2Target, string> = {
  rp2040: firmwareUrlRp2040,
  rp2350: firmwareUrlRp2350,
}

// The pinned Rust firmware + its filesystem layout, from the promoted release
// metadata (read straight from firmware-rust/src/fs.rs — see promote-firmware, so
// it can't drift). The FS holds the pattern + config; the firmware IS the player
// (no main.py / leda.mpy). RP2040 and RP2350 share the same 2 MB fs geometry, so
// the capacity helpers use rp2040's numbers for both. Bump firmware with
// `npm run promote-firmware`.
const FS = FIRMWARE_RELEASES.rp2040.combinedUf2! // rp2040 is a uf2 target, always present

/** Conservative usable capacity for a single pattern (reserve for FS metadata). */
export function usableFsBytes(): number {
  return (FS.blockCount - 12) * FS.blockSize
}

/** Bytes the filesystem region can hold (the size shown against the pattern size). */
export function fsCapacityBytes(): number {
  return FS.blockCount * FS.blockSize
}

/** Config files the Rust firmware reads at boot. GP0 is fixed, so no datapin.txt. */
function settingsFiles(brightness: number, name: string, patternFile: string): Record<string, string> {
  return {
    'bright.txt': String(Math.round(brightness * 100)),
    'devicename.txt': name,
    'selected.txt': patternFile,
  }
}

/**
 * Build a one-drag combined UF2 = the pinned **Rust firmware** for `target` + a
 * LittleFS image holding the pattern + its config. Drag onto RPI-RP2 → a blank
 * Pico (W) / Pico 2 W plays the animation on boot. (The firmware is the player;
 * no MicroPython.)
 */
export async function buildCombinedUf2(
  target: Uf2Target,
  raster: Raster,
  brightness: number,
  patternFile: string,
  name?: string,
  meta?: LedaMeta,
  /** Pre-encoded pattern bytes (e.g. RGB565/indexed); defaults to RGB888. */
  pattern?: Uint8Array,
): Promise<Uint8Array> {
  const fs = FIRMWARE_RELEASES[target].combinedUf2! // uf2 targets always carry this
  const enc = new TextEncoder()
  const settings = settingsFiles(brightness, name ?? 'LED Animator', patternFile)
  const files = [
    { name: patternFile, data: pattern ?? encodeRaster(raster, meta) },
    ...Object.entries(settings).map(([n, v]) => ({ name: n, data: enc.encode(v) })),
  ]

  const total = files.reduce((sum, f) => sum + f.data.length, 0)
  const usable = usableFsBytes()
  if (total > usable) {
    throw new Error(
      `Pattern is too large for the device filesystem (${(total / 1024).toFixed(0)} KB > ~${(usable / 1024).toFixed(0)} KB). ` +
        'Shorten the loop, lower the fps, or reduce the LED count.',
    )
  }

  const fsImage = await buildLittleFsImage(files, fs.blockCount, fs.blockSize)
  const firmware = new Uint8Array(await (await fetch(FIRMWARE_URL[target])).arrayBuffer())
  return assembleCombinedUf2(firmware, fsImage, fs.fsBase, fs.family)
}
