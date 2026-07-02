// Minimal UF2 (USB Flashing Format) reader/writer for RP2040.
// A UF2 file is a sequence of 512-byte blocks, each carrying up to 256 bytes of
// payload plus its target flash address. See https://github.com/microsoft/uf2

const MAGIC0 = 0x0a324655
const MAGIC1 = 0x9e5d5157
const MAGIC_END = 0x0ab16f30
const FLAG_FAMILY_ID = 0x2000
const RP2040_FAMILY = 0xe48bff56
const PAYLOAD = 256

export interface Uf2Block {
  addr: number
  data: Uint8Array // 256 bytes
}

export function parseUf2(buf: Uint8Array): Uf2Block[] {
  if (buf.length % 512 !== 0) throw new Error('UF2 length is not a multiple of 512')
  const blocks: Uf2Block[] = []
  for (let i = 0; i < buf.length; i += 512) {
    const dv = new DataView(buf.buffer, buf.byteOffset + i, 512)
    if (dv.getUint32(0, true) !== MAGIC0 || dv.getUint32(4, true) !== MAGIC1) {
      throw new Error('bad UF2 block magic')
    }
    blocks.push({ addr: dv.getUint32(12, true), data: buf.subarray(i + 32, i + 32 + PAYLOAD) })
  }
  return blocks
}

function writeBlock(out: Uint8Array, index: number, addr: number, blockNo: number, numBlocks: number, payload: Uint8Array) {
  const base = index * 512
  const dv = new DataView(out.buffer, base, 512)
  dv.setUint32(0, MAGIC0, true)
  dv.setUint32(4, MAGIC1, true)
  dv.setUint32(8, FLAG_FAMILY_ID, true)
  dv.setUint32(12, addr, true)
  dv.setUint32(16, PAYLOAD, true)
  dv.setUint32(20, blockNo, true)
  dv.setUint32(24, numBlocks, true)
  dv.setUint32(28, RP2040_FAMILY, true)
  out.set(payload.subarray(0, PAYLOAD), base + 32)
  dv.setUint32(508, MAGIC_END, true)
}

/**
 * Splice a filesystem image into a firmware UF2 at `fsBase`, producing one
 * combined UF2 (firmware blocks + FS blocks, renumbered). Throws if the
 * firmware extends past the FS base — the safety net that stops a stale
 * firmware/param mismatch from writing the FS into the firmware region.
 */
export function assembleCombinedUf2(firmwareUf2: Uint8Array, fsImage: Uint8Array, fsBase: number): Uint8Array {
  const fw = parseUf2(firmwareUf2)
  const fwTop = fw.reduce((max, b) => Math.max(max, b.addr + PAYLOAD), 0)
  if (fwTop > fsBase) {
    throw new Error(
      `Firmware extends to 0x${fwTop.toString(16)}, past the FS base 0x${fsBase.toString(16)} — ` +
        'the pinned firmware and filesystem parameters are out of sync.',
    )
  }
  const fsBlocks = Math.ceil(fsImage.length / PAYLOAD)
  const total = fw.length + fsBlocks
  const out = new Uint8Array(total * 512)
  let n = 0
  for (const b of fw) {
    writeBlock(out, n, b.addr, n, total, b.data)
    n++
  }
  for (let off = 0; off < fsImage.length; off += PAYLOAD) {
    const chunk = fsImage.subarray(off, off + PAYLOAD)
    const payload = chunk.length === PAYLOAD ? chunk : (() => { const p = new Uint8Array(PAYLOAD); p.set(chunk); return p })()
    writeBlock(out, n, fsBase + off, n, total, payload)
    n++
  }
  return out
}
