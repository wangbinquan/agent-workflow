// Tiny floating context menu used by the workflow canvas for right-clicks
// on nodes (P-2-07). Closes on Escape / outside-click. Single-level menu —
// nested submenus aren't worth the wiring for v1.

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'

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
  /** Stable keyboard focus target restored when the menu closes. */
  triggerRef?: RefObject<HTMLElement | null>
}

export function ContextMenu({ open, x, y, items, onClose, header, triggerRef }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) return
    const restoreTarget = triggerRef?.current
    const timer = window.setTimeout(() => {
      itemRefs.current.find((item) => item !== null && !item.disabled)?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      restoreTarget?.focus()
    }
  }, [open, triggerRef])

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

  const enabledIndices = items.flatMap((item, index) => (item.disabled === true ? [] : [index]))
  const focusAt = (position: number) => {
    if (enabledIndices.length === 0) return
    const wrapped = (position + enabledIndices.length) % enabledIndices.length
    itemRefs.current[enabledIndices[wrapped]!]?.focus()
  }
  const handleMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement)
    const enabledPosition = enabledIndices.indexOf(currentIndex)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(enabledPosition < 0 ? 0 : enabledPosition + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(enabledPosition < 0 ? enabledIndices.length - 1 : enabledPosition - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(enabledIndices.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      const item = items[currentIndex]
      if (item === undefined || item.disabled === true) return
      event.preventDefault()
      item.onSelect()
      onClose()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleMenuKey}
      role="menu"
    >
      {header !== undefined && <div className="context-menu__header">{header}</div>}
      {items.map((it, i) => (
        <button
          key={i}
          ref={(node) => {
            itemRefs.current[i] = node
          }}
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
