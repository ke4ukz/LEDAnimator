// Indexed-color quantization for the LEDA "indexed" pixel format (format 2).
//
// A raster's pixels are reduced to a palette of at most `maxColors` (default 256)
// RGB888 entries + one index byte per pixel. If the raster has ≤ maxColors distinct
// colors the palette is EXACT (lossless); otherwise it's built by median-cut and
// pixels map to their nearest palette entry (`exact` is then false, so the export
// UI can warn / ask before baking an approximation).

export interface IndexedResult {
  /** Palette entries, RGB888, `count × 3` bytes. */
  palette: Uint8Array
  /** Number of palette entries, 1..maxColors. */
  count: number
  /** One palette index per pixel, frame-major (`numFrames × numLeds` bytes). */
  indices: Uint8Array
  /** True when lossless (distinct ≤ maxColors); false when quantized. */
  exact: boolean
  /** Distinct colors in the source raster. */
  distinct: number
}

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

/** Count distinct RGB colors in RGB888 frame-major `data`. Stops early once the
 *  count exceeds `cap` (returns `cap + 1`), so the UI can cheaply ask "does this
 *  fit a 256-color palette?" without scanning unique colors it doesn't need. */
export function countDistinctColors(data: Uint8Array, cap = Infinity): number {
  const seen = new Set<number>()
  for (let i = 0; i + 2 < data.length; i += 3) {
    seen.add(pack(data[i], data[i + 1], data[i + 2]))
    if (seen.size > cap) return cap + 1
  }
  return seen.size
}

/** Build an indexed representation of an RGB888 frame-major raster. */
export function buildIndexed(data: Uint8Array, maxColors = 256): IndexedResult {
  const pixels = (data.length / 3) | 0

  // Distinct colors + how often each occurs (median-cut weights by population).
  const freq = new Map<number, number>()
  for (let i = 0; i + 2 < data.length; i += 3) {
    const key = pack(data[i], data[i + 1], data[i + 2])
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  const distinct = freq.size

  if (distinct === 0) {
    return { palette: new Uint8Array([0, 0, 0]), count: 1, indices: new Uint8Array(0), exact: true, distinct: 0 }
  }

  const keys = [...freq.keys()]

  // Exact path: one palette entry per distinct color, no loss.
  if (distinct <= maxColors) {
    const palette = new Uint8Array(distinct * 3)
    const indexOf = new Map<number, number>()
    for (let i = 0; i < distinct; i++) {
      const k = keys[i]
      palette[i * 3] = (k >> 16) & 0xff
      palette[i * 3 + 1] = (k >> 8) & 0xff
      palette[i * 3 + 2] = k & 0xff
      indexOf.set(k, i)
    }
    return { palette, count: distinct, indices: mapIndices(data, pixels, indexOf), exact: true, distinct }
  }

  // Quantize: median-cut the distinct colors into `maxColors` boxes.
  const r = new Uint8Array(distinct)
  const g = new Uint8Array(distinct)
  const b = new Uint8Array(distinct)
  const pop = new Float64Array(distinct)
  for (let i = 0; i < distinct; i++) {
    const k = keys[i]
    r[i] = (k >> 16) & 0xff
    g[i] = (k >> 8) & 0xff
    b[i] = k & 0xff
    pop[i] = freq.get(k)!
  }

  const order = Uint32Array.from({ length: distinct }, (_, i) => i)
  interface Box { lo: number; hi: number }
  const boxes: Box[] = [{ lo: 0, hi: distinct }]

  const channelRange = (box: Box, ch: Uint8Array): number => {
    let min = 255
    let max = 0
    for (let i = box.lo; i < box.hi; i++) {
      const v = ch[order[i]]
      if (v < min) min = v
      if (v > max) max = v
    }
    return max - min
  }

  while (boxes.length < maxColors) {
    // Pick the splittable box with the widest single-channel spread.
    let best = -1
    let bestRange = 0
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi]
      if (box.hi - box.lo < 2) continue
      const range = Math.max(channelRange(box, r), channelRange(box, g), channelRange(box, b))
      if (range > bestRange) {
        bestRange = range
        best = bi
      }
    }
    if (best < 0) break // nothing left to split

    const box = boxes[best]
    const rr = channelRange(box, r)
    const gr = channelRange(box, g)
    const br = channelRange(box, b)
    const ch = rr >= gr && rr >= br ? r : gr >= br ? g : b
    // Sort this box's colors along the widest channel, split at the population median.
    const slice = Array.from(order.subarray(box.lo, box.hi)).sort((x, y) => ch[x] - ch[y])
    order.set(slice, box.lo)
    let total = 0
    for (let i = box.lo; i < box.hi; i++) total += pop[order[i]]
    let half = total / 2
    let split = box.lo + 1
    for (let i = box.lo; i < box.hi - 1; i++) {
      half -= pop[order[i]]
      if (half <= 0) {
        split = i + 1
        break
      }
    }
    boxes[best] = { lo: box.lo, hi: split }
    boxes.push({ lo: split, hi: box.hi })
  }

  // Palette entry = population-weighted average of each box.
  const count = boxes.length
  const palette = new Uint8Array(count * 3)
  for (let bi = 0; bi < count; bi++) {
    const box = boxes[bi]
    let sr = 0
    let sg = 0
    let sb = 0
    let sp = 0
    for (let i = box.lo; i < box.hi; i++) {
      const c = order[i]
      const w = pop[c]
      sr += r[c] * w
      sg += g[c] * w
      sb += b[c] * w
      sp += w
    }
    palette[bi * 3] = Math.round(sr / sp)
    palette[bi * 3 + 1] = Math.round(sg / sp)
    palette[bi * 3 + 2] = Math.round(sb / sp)
  }

  // Map every distinct color to its nearest palette entry (cached), then pixels.
  const indexOf = new Map<number, number>()
  for (const k of keys) indexOf.set(k, nearest((k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff, palette, count))

  return { palette, count, indices: mapIndices(data, pixels, indexOf), exact: false, distinct }
}

/** Nearest palette entry (squared-distance) to an RGB color. */
function nearest(r: number, g: number, b: number, palette: Uint8Array, count: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < count; i++) {
    const dr = r - palette[i * 3]
    const dg = g - palette[i * 3 + 1]
    const db = b - palette[i * 3 + 2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      best = i
      if (d === 0) break
    }
  }
  return best
}

/** One index byte per pixel from a packed-color → index map. */
function mapIndices(data: Uint8Array, pixels: number, indexOf: Map<number, number>): Uint8Array {
  const indices = new Uint8Array(pixels)
  for (let p = 0; p < pixels; p++) {
    const i = p * 3
    indices[p] = indexOf.get(pack(data[i], data[i + 1], data[i + 2])) ?? 0
  }
  return indices
}
