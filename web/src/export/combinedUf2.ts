import firmwareUrl from '../assets/RPI_PICO_W-v1.28.0.uf2?url'
import type { Raster } from '../types'
import { encodeRaster } from './format'
import { rp2040MainPy } from './rp2040'
import { buildLittleFsImage } from './littlefs'
import { assembleCombinedUf2 } from './uf2'

// Pinned MicroPython firmware + its VERIFIED filesystem layout. To bump the
// firmware: replace the asset, run `os.statvfs('/')` on a board flashed with it,
// and update blockCount here (fsBase is derived; the assembler asserts the
// firmware fits below it). See led-animator-roadmap memory.
export const PICO_W_FIRMWARE = {
  board: 'Raspberry Pi Pico W',
  version: 'v1.28.0',
  blockSize: 4096,
  blockCount: 212, // os.statvfs → 848 KB filesystem
  fsBase: 0x1012c000, // flash_end (0x10200000) − blockCount*blockSize
}

/** Conservative usable capacity for a single pattern (reserve for FS metadata). */
export function usableFsBytes(): number {
  const { blockCount, blockSize } = PICO_W_FIRMWARE
  return (blockCount - 12) * blockSize
}

/**
 * Build a one-drag combined UF2 = pinned MicroPython firmware + a LittleFS image
 * holding main.py + pattern.bin. Drag onto RPI-RP2 → blank board plays the
 * animation on boot.
 */
export async function buildRp2040CombinedUf2(
  raster: Raster,
  pin: number,
  brightness: number,
  name?: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const mainPy = enc.encode(rp2040MainPy(pin, brightness, name))
  const patternBin = encodeRaster(raster)

  const total = mainPy.length + patternBin.length
  const usable = usableFsBytes()
  if (total > usable) {
    throw new Error(
      `Pattern is too large for the Pico W filesystem (${(total / 1024).toFixed(0)} KB > ~${(usable / 1024).toFixed(0)} KB). ` +
        'Shorten the loop, lower the fps, or reduce the LED count.',
    )
  }

  const fsImage = await buildLittleFsImage(
    [{ name: 'main.py', data: mainPy }, { name: 'pattern.bin', data: patternBin }],
    PICO_W_FIRMWARE.blockCount,
    PICO_W_FIRMWARE.blockSize,
  )
  const firmware = new Uint8Array(await (await fetch(firmwareUrl)).arrayBuffer())
  return assembleCombinedUf2(firmware, fsImage, PICO_W_FIRMWARE.fsBase)
}
