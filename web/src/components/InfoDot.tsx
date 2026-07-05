import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Inline "ⓘ" that reveals a details popover on click. The popover is portaled
 * to <body> with fixed positioning so it isn't clipped by a modal's or panel's
 * overflow. Closes on outside-click, Escape, or resize. Stops click propagation
 * so it's safe inside a <label> row (won't toggle the row's control).
 */
export function InfoDot({ label, children }: { label: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    const close = () => setPos(null)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    // Defer a frame so the click that opened us can't immediately close us.
    const id = requestAnimationFrame(() => {
      window.addEventListener('pointerdown', onDown)
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', close)
    })
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggle = (e: React.MouseEvent) => {
    // Don't let the click reach a wrapping <label> (which would toggle its input).
    e.preventDefault()
    e.stopPropagation()
    if (open) return setPos(null)
    const r = btnRef.current!.getBoundingClientRect()
    const half = 137 // half the popover width (270) + a hair
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    // Open above the button, unless it sits in the top half — then drop below,
    // so a tall popover can't run off the top of the screen.
    const above = r.top > window.innerHeight * 0.5
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above })
  }

  return (
    <span className="info">
      <button ref={btnRef} type="button" className="info-dot" aria-label={label} aria-expanded={open} onClick={toggle}>
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="info-pop"
            role="tooltip"
            style={{ left: pos.left, top: pos.top, transform: `translate(-50%, ${pos.above ? '-100%' : '0'})` }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}
