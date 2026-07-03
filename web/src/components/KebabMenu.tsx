import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

/** A ⋮ button that drops a small menu; closes on outside-click or Escape. */
export function KebabMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋮
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              className={`menu-item${item.danger ? ' danger' : ''}`}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
