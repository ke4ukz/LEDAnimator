import { useEffect, useRef } from 'react'
import { type Gradient, evalGradient } from '../gradient'
import { type PostFx, applyPost } from '../project'

/**
 * Renders the full 2D gradient field to a canvas, with post-processing applied
 * so the adjustments (invert / brightness / contrast / saturation) show live.
 */
export function GradientPreview({
  gradient,
  post,
  width = 224,
  height = 224,
}: {
  gradient: Gradient
  post?: PostFx
  width?: number
  height?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = ctx.createImageData(width, height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = applyPost(evalGradient(gradient, x / (width - 1), y / (height - 1)), post)
        const i = (y * width + x) * 4
        img.data[i] = r
        img.data[i + 1] = g
        img.data[i + 2] = b
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [gradient, post, width, height])

  return <canvas ref={ref} width={width} height={height} className="grad-preview" />
}
