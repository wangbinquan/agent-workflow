// Tiny floating context menu used by the workflow canvas for right-clicks
// on nodes (P-2-07). Closes on Escape / outside-click. Single-level menu —
// nested submenus aren't worth the wiring for v1.

import { useEffect, useRef, type ReactNode } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

interface Props {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** Render an optional header above the items (e.g. "node a1"). */
  header?: ReactNode
}

export function ContextMenu({ open, x, y, items, onClose, header }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current === null) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {header !== undefined && <div className="context-menu__header">{header}</div>}
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`context-menu__item ${it.danger === true ? 'context-menu__item--danger' : ''}`}
          disabled={it.disabled === true}
          onClick={() => {
            it.onSelect()
            onClose()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
