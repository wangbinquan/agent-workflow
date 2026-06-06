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
import { useTranslation } from 'react-i18next'

export type DialogSize = 'sm' | 'md' | 'lg'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  size?: DialogSize
  children: ReactNode
  footer?: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
  /**
   * Element to focus on close. Pass the ref of the trigger element so a
   * keyboard user lands back where they started. The Dialog falls back
   * to whatever `document.activeElement` was at open time, but that's
   * fragile across browsers — Safari/WebKit doesn't focus `<button>` on
   * mouse click, so capturing at open time may leave us with `<body>`
   * and close-time focus restoration becomes a no-op. Pass `triggerRef`
   * explicitly when the contract matters (see e2e/keyboard-flows.spec.ts).
   */
  triggerRef?: RefObject<HTMLElement | null>
  closeOnOverlayClick?: boolean
  closeOnEsc?: boolean
  'aria-label'?: string
  'data-testid'?: string
  /** Extra class names appended to the standard `.dialog__panel`. */
  panelClassName?: string
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Focus is "inside the dialog" if it's in the panel itself OR inside a
// popover that a control *within* the panel owns via `aria-controls`. The
// latter covers floating layers that are intentionally portaled to
// `document.body` to escape the panel's overflow clipping — most notably
// <Select>'s listbox (combobox[aria-controls=id] → <ul id=id>). Without
// this, the focus trap below would yank focus out of an open <Select>
// back to the panel's first focusable (the × close button), which both
// breaks the dropdown and scroll-jumps the panel to the top.
// Locked by tests/dialog-portal-focus.test.tsx.
function isFocusInsideDialog(panel: HTMLElement, node: Node | null): boolean {
  if (node === null) return false
  if (panel.contains(node)) return true
  for (const owner of panel.querySelectorAll('[aria-controls]')) {
    const id = owner.getAttribute('aria-controls')
    if (id === null || id === '') continue
    const owned = document.getElementById(id)
    if (owned !== null && owned.contains(node)) return true
  }
  return false
}

export function Dialog(props: DialogProps): ReactElement | null {
  const { t } = useTranslation()
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
  // opened so we can hand it back on close; set initial focus. The
  // explicit `triggerRef` prop wins over the auto-captured
  // `document.activeElement` — that auto-capture lies on Safari/WebKit
  // where mouse-clicking a `<button>` does NOT focus it (it captures
  // `<body>` instead, and `body.focus()` on close is a no-op). Locked
  // by e2e/keyboard-flows.spec.ts (Escape→focus-restore).
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!props.open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const focusTimer = window.setTimeout(() => {
      const target =
        props.initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current
      target?.focus?.()
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      const restoreTarget = props.triggerRef?.current ?? restoreRef.current
      restoreTarget?.focus?.()
    }
  }, [props.open, props.initialFocusRef, props.triggerRef])

  // Focus trap — yank focus back whenever it lands outside the panel.
  // The previous implementation intercepted Tab/Shift+Tab keydowns and
  // wrapped at `active === last` / `active === first` boundaries. That
  // breaks on WebKit (macOS Safari + Playwright webkit) because Safari's
  // default Tab key skips non-form-control elements — focus walks past
  // our `last` button into form fields on the page outside the dialog
  // before the keydown handler ever sees `active === last`, so the trap
  // never fires. The `focusin` redirect below is the cross-browser
  // primitive: it activates AFTER focus actually moves, so it works
  // regardless of what key (or programmatic .focus()) caused the move.
  // Locked by tests/dialog.test.tsx and e2e/keyboard-flows.spec.ts.
  useEffect(() => {
    if (!props.open) return
    const yankBack = () => {
      const panel = panelRef.current
      if (panel === null) return
      const ae = document.activeElement
      if (ae !== null && ae !== document.body && isFocusInsideDialog(panel, ae)) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      ;(focusables[0] ?? panel).focus?.()
    }
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current
      if (panel === null) return
      const target = e.target as Node | null
      if (target !== null && isFocusInsideDialog(panel, target)) return
      yankBack()
    }
    // `focusout` safety net: Linux WebKit (Playwright WPE build) doesn't
    // reliably fire `focusin` on `body` when Tab walks past the panel's
    // last focusable. The corresponding `focusout` on the panel-side
    // element DOES fire — defer via microtask so `document.activeElement`
    // has settled, then redirect if it ended up outside.
    const onFocusOut = () => queueMicrotask(yankBack)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
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
            aria-label={t('common.close')}
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
