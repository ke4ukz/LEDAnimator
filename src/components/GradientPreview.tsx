import { useEffect, useRef } from 'react'
import { type Gradient, evalGradient } from '../gradient'

/**
 * Renders the full 2D gradient field to a canvas, with a dashed line marking
 * the default horizontal sampling path (v = 0.5) the ring currently reads.
 */
export function GradientPreview({
  gradient,
  width = 224,
  height = 120,
}: {
  gradient: Gradient
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
        const [r, g, b] = evalGradient(gradient, x / (width - 1), y / (height - 1))
        const i = (y * width + x) * 4
        img.data[i] = r
        img.data[i + 1] = g
        img.data[i + 2] = b
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)

    // Mark the v = 0.5 sampling path.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()
  }, [gradient, width, height])

  return <canvas ref={ref} width={width} height={height} className="grad-preview" />
}
