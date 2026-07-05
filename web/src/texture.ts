import type { RGB } from './types'
import { type GradientSource, applyPost } from './project'
import { evalGradient } from './gradient'

// The single source of truth for color: every source is rasterized to a square
// RGB grid, and BOTH the export bake and the on-screen loupe/swatch read that
// same grid with nearest-neighbor sampling. So "what the loupe shows" is exactly
// "what gets exported", and the model already fits future image sources (which
// arrive as a pixel grid and simply skip the rasterize step).
//
// Resolution is a deliberate ceiling, not a fidelity knob: the export only ever
// reads a handful of 1D samples per frame, so ~1k out-resolves any realistic LED
// count while keeping the CPU rasterize (~1M evals) and memory (~3 MB) cheap.
// It's built lazily (first loupe hover or export), so live editing never pays
// for it. See the discussion in git history before raising this.
export const SOURCE_TEXTURE_RES = 1024

export interface SourceTexture {
  res: number
  /** Row-major RGB, length res * res * 3. */
  data: Uint8ClampedArray
}

const texCache = new WeakMap<object, SourceTexture>()
const canvasCache = new WeakMap<object, HTMLCanvasElement>()

/** Rasterize a gradient source to an RGB grid with post-processing baked in. */
function rasterize(source: GradientSource, res: number): SourceTexture {
  const data = new Uint8ClampedArray(res * res * 3)
  const { gradient, post } = source
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) / res
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) / res
      const [r, g, b] = applyPost(evalGradient(gradient, u, v), post)
      const i = (y * res + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return { res, data }
}

/** The source's texture, built once per source object (cache invalidates when
 *  the store replaces the source on any gradient/post edit). */
export function getSourceTexture(source: GradientSource, res = SOURCE_TEXTURE_RES): SourceTexture {
  let t = texCache.get(source)
  if (!t || t.res !== res) {
    t = rasterize(source, res)
    texCache.set(source, t)
  }
  return t
}

/** Nearest-neighbor sample at normalized (u, v) — the exact texel the export
 *  reads and the loupe draws. Each texel j covers [j/res, (j+1)/res). */
export function sampleNearest(tex: SourceTexture, u: number, v: number): RGB {
  const { res, data } = tex
  const xi = Math.min(res - 1, Math.max(0, Math.floor(u * res)))
  const yi = Math.min(res - 1, Math.max(0, Math.floor(v * res)))
  const i = (yi * res + xi) * 3
  return [data[i], data[i + 1], data[i + 2]]
}

/** The texture as a canvas, so a loupe can `drawImage` a cropped region scaled
 *  up with nearest-neighbor to show the individual source pixels crisply. */
export function getSourceCanvas(source: GradientSource, res = SOURCE_TEXTURE_RES): HTMLCanvasElement {
  const cached = canvasCache.get(source)
  if (cached && cached.width === res) return cached

  const tex = getSourceTexture(source, res)
  const canvas = document.createElement('canvas')
  canvas.width = res
  canvas.height = res
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(res, res)
  for (let p = 0, q = 0; p < tex.data.length; p += 3, q += 4) {
    img.data[q] = tex.data[p]
    img.data[q + 1] = tex.data[p + 1]
    img.data[q + 2] = tex.data[p + 2]
    img.data[q + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  canvasCache.set(source, canvas)
  return canvas
}
