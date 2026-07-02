import createLittleFS from 'littlefs'
import wasmUrl from 'littlefs/dist/littlefs.wasm?url'

// Build a LittleFS filesystem image in the browser using wokwi's littlefs-wasm.
// The produced Uint8Array is the raw flash image (block_count * block_size),
// ready to wrap into UF2 blocks. Proven mountable by MicroPython (see the
// roadmap notes: format/mount/write verified, round-trips through UF2).

export interface FsFile {
  name: string
  data: Uint8Array
}

let wasmPromise: Promise<ArrayBuffer> | null = null
const wasm = () => (wasmPromise ??= fetch(wasmUrl).then((r) => r.arrayBuffer()))

export async function buildLittleFsImage(files: FsFile[], blockCount: number, blockSize: number): Promise<Uint8Array> {
  const wasmBinary = new Uint8Array(await wasm())
  const flash = new Uint8Array(blockCount * blockSize).fill(0xff)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await (createLittleFS as any)({ wasmBinary })

  // Block device callbacks over the JS `flash` buffer. All return 0 (success).
  const read = (_c: number, b: number, o: number, buf: number, s: number) => {
    m.HEAPU8.set(flash.subarray(b * blockSize + o, b * blockSize + o + s), buf)
    return 0
  }
  const prog = (_c: number, b: number, o: number, buf: number, s: number) => {
    flash.set(m.HEAPU8.subarray(buf, buf + s), b * blockSize + o)
    return 0
  }
  const erase = (_c: number, b: number) => {
    flash.fill(0xff, b * blockSize, (b + 1) * blockSize)
    return 0
  }
  const rp = m.addFunction(read, 'iiiiii')
  const pp = m.addFunction(prog, 'iiiiii')
  const ep = m.addFunction(erase, 'iii')
  const sp = m.addFunction(() => 0, 'ii')

  const cfg = m._new_lfs_config(rp, pp, ep, sp, blockCount, blockSize)
  const lfs = m._new_lfs()
  if (m._lfs_format(lfs, cfg)) throw new Error('LittleFS format failed')
  if (m._lfs_mount(lfs, cfg)) throw new Error('LittleFS mount failed')

  const enc = new TextEncoder()
  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    // No _malloc exported — marshal name + data through the stack.
    const sp2 = m.stackSave()
    const np = m.stackAlloc(nameBytes.length + 1)
    m.HEAPU8.set(nameBytes, np)
    m.HEAPU8[np + nameBytes.length] = 0
    const dp = m.stackAlloc(f.data.length)
    m.HEAPU8.set(f.data, dp)
    m._lfs_write_file(lfs, np, dp, f.data.length)
    m.stackRestore(sp2)
  }
  m._lfs_unmount(lfs)
  return flash
}
