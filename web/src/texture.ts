import type { RGB } from './types'
import { type GradientSource, type ImageSource, type Source, applyPost } from './project'
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

// A tiny opaque-black stand-in returned while an image is still decoding; never
// cached, so the next call after decode produces the real texture.
const PLACEHOLDER: SourceTexture = { res: 1, data: new Uint8ClampedArray([0, 0, 0]) }

// Raw decoded image pixels keyed by data URL (decoded once, shared across
// sources and post edits). `null` means a decode is in flight.
const rawImageCache = new Map<string, SourceTexture | null>()

let readyListener: (() => void) | null = null
/** Register a callback fired when an async image decode finishes, so the app can
 *  re-bake / re-render now that the real pixels exist. */
export function setTextureReadyListener(fn: () => void) {
  readyListener = fn
}

/** Kick off a one-time async decode of an image data URL into a square RGB grid. */
function decodeImage(url: string) {
  if (rawImageCache.has(url)) return // decoding or already done
  rawImageCache.set(url, null)
  const img = new Image()
  img.onload = () => {
    const res = SOURCE_TEXTURE_RES
    const canvas = document.createElement('canvas')
    canvas.width = res
    canvas.height = res
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, res, res) // stretch to the square source space
    const px = ctx.getImageData(0, 0, res, res).data
    const data = new Uint8ClampedArray(res * res * 3)
    for (let p = 0, q = 0; q < px.length; p += 3, q += 4) {
      data[p] = px[q]
      data[p + 1] = px[q + 1]
      data[p + 2] = px[q + 2]
    }
    rawImageCache.set(url, { res, data })
    readyListener?.()
  }
  img.onerror = () => {
    rawImageCache.set(url, PLACEHOLDER) // couldn't decode → stays black
    readyListener?.()
  }
  img.src = url
}

/** An image source's texture: the decoded pixels with post-processing applied.
 *  Returns the placeholder (and starts a decode) until the pixels are ready. */
function imageTexture(source: ImageSource): SourceTexture {
  const raw = rawImageCache.get(source.image)
  if (raw === undefined) {
    decodeImage(source.image)
    return PLACEHOLDER
  }
  if (raw === null || raw === PLACEHOLDER) return PLACEHOLDER
  if (!source.post) return raw // no adjustments → share the raw grid
  const { res, data: src } = raw
  const data = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 3) {
    const [r, g, b] = applyPost([src[i], src[i + 1], src[i + 2]], source.post)
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
  return { res, data }
}

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
 *  the store replaces the source on any gradient/post/image edit). Image sources
 *  return a black placeholder until their async decode completes. */
export function getSourceTexture(source: Source, res = SOURCE_TEXTURE_RES): SourceTexture {
  const cached = texCache.get(source)
  if (cached && cached.res === res) return cached
  const t = source.kind === 'image' ? imageTexture(source) : rasterize(source, res)
  if (t !== PLACEHOLDER) texCache.set(source, t)
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
export function getSourceCanvas(source: Source, res = SOURCE_TEXTURE_RES): HTMLCanvasElement {
  const cached = canvasCache.get(source)
  if (cached) return cached

  const tex = getSourceTexture(source, res)
  const canvas = document.createElement('canvas')
  canvas.width = tex.res
  canvas.height = tex.res
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(tex.res, tex.res)
  for (let p = 0, q = 0; p < tex.data.length; p += 3, q += 4) {
    img.data[q] = tex.data[p]
    img.data[q + 1] = tex.data[p + 1]
    img.data[q + 2] = tex.data[p + 2]
    img.data[q + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  if (tex !== PLACEHOLDER) canvasCache.set(source, canvas)
  return canvas
}
