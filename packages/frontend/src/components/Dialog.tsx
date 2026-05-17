// RFC-035 PR3 — shared dialog primitive.
//
// Replaces three bespoke overlay implementations:
//   - AgentImportDialog (.agent-import__overlay/__panel/__header/__close/__footer)
//   - inline ReviewDecisionDialog in reviews.detail.tsx
//     (.review-decision-dialog__overlay/__panel/__header/__close/__body/__actions)
//   - BatchImportDialog (.modal.batch-import-dialog)
//
// Owns the chrome (overlay + panel + header + close + body slot + footer)
// + focus trap + ESC + outside-click + portal + body overflow lock + a11y
// (role=dialog + aria-modal + aria-labelledby). Body content is owned by
// callers.

import { useEffect, useId, useRef, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type DialogSize = 'sm' | 'md' | 'lg'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  size?: DialogSize
  children: ReactNode
  footer?: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
  closeOnOverlayClick?: boolean
  closeOnEsc?: boolean
  'aria-label'?: string
  'data-testid'?: string
  /** Extra class names appended to the standard `.dialog__panel`. */
  panelClassName?: string
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog(props: DialogProps): ReactElement | null {
  const size: DialogSize = props.size ?? 'md'
  const closeOnOverlay = props.closeOnOverlayClick ?? true
  const closeOnEsc = props.closeOnEsc ?? true
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  // Lock body scroll, restore on close. We track the previous overflow
  // value so this cooperates with any other component that might also
  // be locking it (extremely unlikely, but cheap to be correct).
  useEffect(() => {
    if (!props.open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [props.open])

  // ESC handler.
  useEffect(() => {
    if (!props.open || !closeOnEsc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, closeOnEsc, props])

  // Focus management: remember the element that had focus before we
  // opened so we can hand it back on close; set initial focus.
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!props.open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => {
      const target =
        props.initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current
      target?.focus?.()
    }, 0)
    return () => {
      window.clearTimeout(t)
      restoreRef.current?.focus?.()
    }
  }, [props.open, props.initialFocusRef])

  // Focus trap — keep Tab / Shift+Tab cycling within the panel.
  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || panelRef.current === null) return
      const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last?.focus?.()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first?.focus?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open])

  if (!props.open) return null

  const panelClasses = ['dialog__panel']
  if (props.panelClassName !== undefined && props.panelClassName !== '') {
    panelClasses.push(props.panelClassName)
  }

  const overlay = (
    <div
      ref={overlayRef}
      className={`dialog__overlay dialog--${size}`}
      onMouseDown={(e) => {
        if (!closeOnOverlay) return
        if (e.target === overlayRef.current) props.onClose()
      }}
      data-testid={props['data-testid']}
    >
      <div
        ref={panelRef}
        className={panelClasses.join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={props['aria-label']}
        tabIndex={-1}
      >
        <header className="dialog__header">
          <h2 id={titleId}>{props.title}</h2>
          <button
            type="button"
            className="dialog__close"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="dialog__body">{props.children}</div>
        {props.footer !== undefined && <footer className="dialog__footer">{props.footer}</footer>}
      </div>
    </div>
  )

  // happy-dom (vitest environment) still has `document.body`, so the
  // portal works in tests too.
  return createPortal(overlay, document.body)
}
