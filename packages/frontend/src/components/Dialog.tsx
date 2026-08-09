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

export type DialogSize = 'sm' | 'md' | 'lg' | 'full'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  size?: DialogSize
  children: ReactNode
  footer?: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Optional focus target for result dialogs whose heading must be announced. */
  titleRef?: RefObject<HTMLHeadingElement | null>
  /**
   * Makes the body scroll region keyboard-focusable when a phase contains no
   * naturally tabbable body controls. Keep this opt-in so ordinary form
   * dialogs do not gain an extra tab stop.
   */
  bodyTabIndex?: 0
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
  /** Stable fallback when the original trigger unmounts before close. */
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
  /** Locks every dismiss path while an owned transaction is pending. */
  dismissDisabled?: boolean
  closeOnOverlayClick?: boolean
  closeOnEsc?: boolean
  'aria-label'?: string
  'data-testid'?: string
  /** Extra class names appended to the standard `.dialog__panel`. */
  panelClassName?: string
}

const FOCUSABLE =
  'a[href]:not([hidden]), button:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'

// Module-level stack of currently-OPEN dialog panels, in mount order. Nested
// dialogs (RFC-099's owner-transfer dialog lives inside the permissions
// dialog) register here so that only the TOPMOST dialog runs its focus trap
// and its ESC handler:
//   - two live traps yank focus at each other in a synchronous focusin loop
//     and freeze the page (user report: "转让所有者的弹窗弹出来后，界面必死");
//   - two live ESC listeners both fire on one keypress (stopPropagation does
//     not stop sibling listeners on the same window node), closing BOTH
//     layers at once.
// When the inner dialog closes it pops off, the outer becomes top again, and
// the inner's focus-restore lands back on its trigger inside the outer panel.
// Locked by tests/dialog-nested.test.tsx.
const openDialogStack: Array<RefObject<HTMLDivElement | null>> = []

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

function tryFocus(target: HTMLElement | null | undefined): boolean {
  if (target === null || target === undefined || !target.isConnected) return false
  target.focus?.()
  return document.activeElement === target
}

function isAvailableFocusTarget(target: HTMLElement | null | undefined): target is HTMLElement {
  if (target === null || target === undefined || !target.isConnected) return false
  if (target.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false
  if ('disabled' in target && (target as HTMLButtonElement).disabled) return false
  return target.getAttribute('aria-disabled') !== 'true'
}

/** RFC-250: default focus starts in the task body, never on the chrome ×. */
export function resolveInitialDialogFocus(
  panel: HTMLElement,
  explicit: HTMLElement | null | undefined,
): HTMLElement {
  if (isAvailableFocusTarget(explicit)) return explicit
  const marked = panel.querySelector<HTMLElement>('[data-dialog-autofocus]')
  if (isAvailableFocusTarget(marked)) return marked
  const body = panel.querySelector<HTMLElement>('.dialog__body')
  const bodyTarget = Array.from(body?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).find(
    isAvailableFocusTarget,
  )
  return bodyTarget ?? panel
}

export function Dialog(props: DialogProps): ReactElement | null {
  const { t } = useTranslation()
  const { open, onClose } = props
  const size: DialogSize = props.size ?? 'md'
  const closeOnOverlay = props.closeOnOverlayClick ?? true
  const closeOnEsc = props.closeOnEsc ?? true
  const dismissDisabled = props.dismissDisabled ?? false
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

  // Register on the open-dialog stack (see openDialogStack above). This
  // effect is declared BEFORE the initial-focus effect so a nested dialog is
  // already top-of-stack by the time its 0ms focus timer moves focus — the
  // outer dialog's trap must already be inert at that point.
  useEffect(() => {
    if (!props.open) return
    openDialogStack.push(panelRef)
    return () => {
      const i = openDialogStack.indexOf(panelRef)
      if (i >= 0) openDialogStack.splice(i, 1)
    }
  }, [props.open])

  const isTopDialog = () => openDialogStack[openDialogStack.length - 1] === panelRef

  // ESC handler.
  useEffect(() => {
    if (!open || !closeOnEsc || dismissDisabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A child popover may consume Escape by calling preventDefault().
        // React portals still bubble through the component tree, but browser
        // event ordering can let this window listener observe the same key
        // after the child handler. Respecting defaultPrevented keeps the first
        // Escape scoped to that child layer (for example <Select>'s listbox).
        if (e.defaultPrevented) return
        // Nested dialogs: only the topmost layer answers ESC — sibling
        // window listeners all see the event regardless of stopPropagation.
        if (!isTopDialog()) return
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeOnEsc, dismissDisabled, onClose])

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
      const panel = panelRef.current
      if (panel === null) return
      const target = resolveInitialDialogFocus(panel, props.initialFocusRef?.current)
      if (!tryFocus(target)) tryFocus(panel)
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      if (tryFocus(props.triggerRef?.current)) return
      if (tryFocus(props.restoreFocusFallbackRef?.current)) return
      tryFocus(restoreRef.current)
    }
  }, [props.open, props.initialFocusRef, props.triggerRef, props.restoreFocusFallbackRef])

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
    type TabEscapeToken = {
      direction: 'forward' | 'backward'
      source: HTMLElement
      confirmed: boolean
    }
    let tabToken: TabEscapeToken | null = null
    const clearTabToken = () => {
      tabToken = null
    }
    const yankBack = (direction?: 'forward' | 'backward') => {
      // Nested dialogs: an inert lower layer must never fight the top
      // dialog's trap — that tug-of-war is a synchronous focusin loop.
      if (!isTopDialog()) return
      const panel = panelRef.current
      if (panel === null) return
      const ae = document.activeElement
      if (ae !== null && ae !== document.body && isFocusInsideDialog(panel, ae)) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        isAvailableFocusTarget,
      )
      const target =
        direction === 'backward'
          ? (focusables.at(-1) ?? panel)
          : direction === 'forward'
            ? (focusables[0] ?? panel)
            : resolveInitialDialogFocus(panel, props.initialFocusRef?.current)
      clearTabToken()
      if (!tryFocus(target)) tryFocus(panel)
    }
    const onFocusIn = (e: FocusEvent) => {
      if (!isTopDialog()) return
      const panel = panelRef.current
      if (panel === null) return
      const target = e.target as Node | null
      if (target !== null && isFocusInsideDialog(panel, target)) {
        clearTabToken()
        return
      }
      const direction = tabToken?.confirmed === true ? tabToken.direction : undefined
      yankBack(direction)
    }
    // `focusout` safety net: Linux WebKit (Playwright WPE build) doesn't
    // reliably fire `focusin` on `body` when Tab walks past the panel's
    // last focusable. The corresponding `focusout` on the panel-side
    // element DOES fire — defer via microtask so `document.activeElement`
    // has settled, then redirect if it ended up outside.
    //
    // RFC-099 follow-up: when focus is moving WITHIN the dialog (e.g. from
    // the × button to an input the user just clicked), do NOT queue the
    // yank. The microtask checkpoint runs between the native blur and the
    // native focus — at that instant activeElement is transiently <body>,
    // so an unconditional yank steals the in-flight focus and lands it on
    // the panel's first focusable (the ×), eating the click ("搜索用户
    // textbox 无法使用" was exactly this race). `relatedTarget` on focusout
    // is the element about to RECEIVE focus; inside-the-dialog moves skip
    // the net, while real escapes (relatedTarget outside or null) keep it.
    const onFocusOut = (e: FocusEvent) => {
      const panel = panelRef.current
      if (panel === null) return
      const next = e.relatedTarget as Node | null
      if (next !== null && isFocusInsideDialog(panel, next)) {
        clearTabToken()
        return
      }
      if (tabToken !== null) {
        if (e.target === tabToken.source) tabToken.confirmed = true
        else clearTabToken()
      }
      const direction = tabToken?.confirmed === true ? tabToken.direction : undefined
      queueMicrotask(() => yankBack(direction))
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopDialog()) return
      if (e.key !== 'Tab') {
        clearTabToken()
        return
      }
      const panel = panelRef.current
      const source = document.activeElement
      if (
        panel === null ||
        !(source instanceof HTMLElement) ||
        !isFocusInsideDialog(panel, source)
      ) {
        clearTabToken()
        return
      }
      tabToken = {
        direction: e.shiftKey ? 'backward' : 'forward',
        source,
        confirmed: false,
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Tab') clearTabToken()
    }
    const onPointerDown = () => clearTabToken()
    const onWindowBlur = () => clearTabToken()
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [props.open, props.initialFocusRef])

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
        if (!closeOnOverlay || dismissDisabled) return
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
          <h2
            id={titleId}
            ref={props.titleRef}
            tabIndex={props.titleRef === undefined ? undefined : -1}
          >
            {props.title}
          </h2>
          <button
            type="button"
            className="dialog__close"
            onClick={props.onClose}
            disabled={dismissDisabled}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </header>
        <div className="dialog__body" tabIndex={props.bodyTabIndex}>
          {props.children}
        </div>
        {props.footer !== undefined && <footer className="dialog__footer">{props.footer}</footer>}
      </div>
    </div>
  )

  // happy-dom (vitest environment) still has `document.body`, so the
  // portal works in tests too.
  return createPortal(overlay, document.body)
}
