import { useEffect, useRef } from 'react'
import { type Gradient, evalGradient } from '../gradient'
import { type PostFx, applyPost } from '../project'

/** A sub-window of the gradient's normalized (u,v) space, for the magnifier. */
export interface GradientView {
  u0: number
  v0: number
  u1: number
  v1: number
}

/**
 * Renders the 2D gradient field to a canvas, with post-processing applied so the
 * adjustments (invert / brightness / contrast / saturation) show live. Pass
 * `view` to render just a sub-region (used as a zoomed loupe).
 */
export function GradientPreview({
  gradient,
  post,
  width = 224,
  height = 224,
  view,
}: {
  gradient: Gradient
  post?: PostFx
  width?: number
  height?: number
  view?: GradientView
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = view ?? {}

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = ctx.createImageData(width, height)
    for (let y = 0; y < height; y++) {
      const v = v0 + (v1 - v0) * (height > 1 ? y / (height - 1) : 0)
      for (let x = 0; x < width; x++) {
        const u = u0 + (u1 - u0) * (width > 1 ? x / (width - 1) : 0)
        const [r, g, b] = applyPost(evalGradient(gradient, u, v), post)
        const i = (y * width + x) * 4
        img.data[i] = r
        img.data[i + 1] = g
        img.data[i + 2] = b
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [gradient, post, width, height, u0, v0, u1, v1])

  return <canvas ref={ref} width={width} height={height} className="grad-preview" />
}
