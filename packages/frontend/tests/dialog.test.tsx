// RFC-035 PR3 — render matrix + a11y for the shared <Dialog>.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Dialog } from '../src/components/Dialog'
import { Field, TextInput } from '../src/components/Form'

afterEach(() => {
  // React 19 + happy-dom + createPortal: never manually wipe document.body
  // here — that races with React's commit-time portal cleanup. Letting
  // each render's own unmount happen naturally is fine.
  vi.restoreAllMocks()
})

describe('<Dialog />', () => {
  test('open=false renders nothing into document.body', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="t">
        body
      </Dialog>,
    )
    expect(document.querySelector('.dialog__overlay')).toBeNull()
  })

  test('open=true renders role="dialog" + aria-modal + aria-labelledby', () => {
    render(
      <Dialog open onClose={() => {}} title="My Title">
        body
      </Dialog>,
    )
    const panel = document.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    const titleId = panel?.getAttribute('aria-labelledby')
    expect(titleId).not.toBeNull()
    expect(document.getElementById(titleId ?? '')?.textContent).toBe('My Title')
  })

  test('ESC triggers onClose by default', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t">
        body
      </Dialog>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('a child-consumed ESC does not close the Dialog', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t">
        body
      </Dialog>,
    )
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('closeOnEsc=false suppresses the ESC handler', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t" closeOnEsc={false}>
        body
      </Dialog>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  test('mousedown on the overlay triggers onClose', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t">
        body
      </Dialog>,
    )
    const overlay = document.querySelector('.dialog__overlay') as HTMLElement
    fireEvent.mouseDown(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('mousedown inside the panel does NOT trigger onClose', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t">
        <button data-testid="inside-btn">Inside</button>
      </Dialog>,
    )
    fireEvent.mouseDown(document.querySelector('.dialog__panel') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('closeOnOverlayClick=false suppresses outside-click close', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="t" closeOnOverlayClick={false}>
        body
      </Dialog>,
    )
    fireEvent.mouseDown(document.querySelector('.dialog__overlay') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('size modifier carries through to the overlay class', () => {
    const cases: Array<'sm' | 'md' | 'lg'> = ['sm', 'md', 'lg']
    for (const size of cases) {
      const { unmount } = render(
        <Dialog open onClose={() => {}} title={`t-${size}`} size={size}>
          body
        </Dialog>,
      )
      expect(document.querySelector(`.dialog--${size}`)).not.toBeNull()
      unmount()
    }
  })

  test('initialFocusRef gets focus after mount', async () => {
    function Probe(): ReactElement {
      const ref = useRef<HTMLButtonElement | null>(null)
      return (
        <Dialog open onClose={() => {}} title="t" initialFocusRef={ref}>
          <button ref={ref} data-testid="focus-target">
            target
          </button>
          <button data-testid="other-btn">other</button>
        </Dialog>
      )
    }
    render(<Probe />)
    // The focus is scheduled in a setTimeout(0) inside the dialog effect.
    await new Promise((r) => setTimeout(r, 5))
    expect(document.activeElement?.getAttribute('data-testid')).toBe('focus-target')
  })

  test('TextInput inputRef supports initial focus and Field ids wire grouped validation', async () => {
    function Probe(): ReactElement {
      const ref = useRef<HTMLInputElement | null>(null)
      return (
        <Dialog open onClose={() => {}} title="t" initialFocusRef={ref}>
          <Field
            label="Port name"
            labelId="port-name-label"
            error="Name is invalid"
            errorId="port-name-error"
            group
          >
            <TextInput
              inputRef={ref}
              value="Bad Name"
              onChange={() => {}}
              aria-invalid
              aria-describedby="port-name-error"
              data-testid="port-name-input"
            />
          </Field>
        </Dialog>
      )
    }

    render(<Probe />)
    await new Promise((r) => setTimeout(r, 5))

    const input = document.querySelector<HTMLInputElement>('[data-testid="port-name-input"]')
    const group = document.querySelector<HTMLElement>('[role="group"]')
    expect(document.activeElement).toBe(input)
    expect(group?.getAttribute('aria-labelledby')).toBe('port-name-label')
    expect(input?.getAttribute('aria-invalid')).toBe('true')
    expect(input?.getAttribute('aria-describedby')).toBe('port-name-error')
    expect(document.getElementById('port-name-error')?.getAttribute('role')).toBe('alert')
  })

  test('footer slot renders the dialog footer when supplied', () => {
    render(
      <Dialog
        open
        onClose={() => {}}
        title="t"
        footer={<button data-testid="footer-btn">ok</button>}
      >
        body
      </Dialog>,
    )
    expect(document.querySelector('.dialog__footer')).not.toBeNull()
    expect(document.querySelector('[data-testid="footer-btn"]')).not.toBeNull()
  })

  // Locks the focusin-based focus trap introduced after webkit-nightly
  // run 26282474062: programmatically moving focus to an element OUTSIDE
  // the open dialog must be redirected back to the panel's first
  // focusable. Previously the trap intercepted Tab keydowns at the
  // `active === last` boundary, which never fired on macOS WebKit (Safari
  // skips non-form-control elements during native Tab) — focus would
  // leak out before the keydown branch saw `active === last`. Switching
  // to `focusin` redirection fixes WebKit AND tightens the contract for
  // every browser (any caller that calls `outsideButton.focus()` while
  // the dialog is open gets pulled back, not just Tab navigation).
  test('focusin redirect: programmatic focus on an outside element snaps back inside the panel', () => {
    function Probe(): ReactElement {
      return (
        <>
          <button data-testid="outside-btn">Outside</button>
          <Dialog open onClose={() => {}} title="t">
            <button data-testid="inside-1">Inside 1</button>
            <button data-testid="inside-2">Inside 2</button>
          </Dialog>
        </>
      )
    }
    render(<Probe />)
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside-btn"]')
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(outside).not.toBeNull()
    expect(panel).not.toBeNull()
    outside?.focus()
    // happy-dom dispatches `focusin` synchronously from `.focus()`. The
    // dialog's listener should yank focus to the first focusable in the
    // panel (which happens to be the built-in dialog__close × button),
    // NOT leave it on the outside button. We assert "inside the panel"
    // rather than a specific testid so future header / footer changes
    // don't drift this lock.
    const ae = document.activeElement
    expect(ae).not.toBe(outside)
    expect(ae).not.toBe(document.body)
    expect(panel?.contains(ae)).toBe(true)
  })

  // Locks the explicit `triggerRef` contract added after webkit-nightly
  // run 26293636014. Linux WebKit (Playwright WPE) doesn't focus <button>
  // on click, so `document.activeElement` at open time is unreliable.
  // Callers can pass `triggerRef` and the Dialog must prefer it on close.
  test('triggerRef wins over activeElement-at-open for focus restoration', async () => {
    function Probe(): ReactElement {
      const triggerRef = useRef<HTMLButtonElement | null>(null)
      const [open, setOpen] = useState(false)
      return (
        <>
          <button ref={triggerRef} data-testid="real-trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="t" triggerRef={triggerRef}>
            <button data-testid="inside">Inside</button>
          </Dialog>
        </>
      )
    }
    const { rerender: _rerender } = render(<Probe />)
    // Programmatically open the dialog WITHOUT focusing the trigger first
    // (simulating Safari's "click doesn't focus" behaviour where
    // document.activeElement at open is <body>, not the trigger).
    const opener = document.querySelector<HTMLButtonElement>('[data-testid="real-trigger"]')
    expect(opener).not.toBeNull()
    // Sanity: ensure body is the active element (not the trigger).
    ;(document.body as HTMLElement).focus?.()
    opener?.click()
    // Wait for the dialog's initial-focus setTimeout(0).
    await new Promise((r) => setTimeout(r, 5))
    // Close via Escape → effect cleanup runs → Dialog restores focus
    // to triggerRef.current (the button), NOT to <body>.
    fireEvent.keyDown(window, { key: 'Escape' })
    await new Promise((r) => setTimeout(r, 5))
    expect(document.activeElement?.getAttribute('data-testid')).toBe('real-trigger')
  })

  test('focusin redirect: focusing inside the panel is a no-op (does not bounce focus around)', () => {
    render(
      <Dialog open onClose={() => {}} title="t">
        <button data-testid="inside-1">Inside 1</button>
        <button data-testid="inside-2">Inside 2</button>
      </Dialog>,
    )
    const inside2 = document.querySelector<HTMLButtonElement>('[data-testid="inside-2"]')
    inside2?.focus()
    // Must NOT redirect to inside-1 — focus is already inside the panel,
    // the trap stays out of the way.
    expect(document.activeElement?.getAttribute('data-testid')).toBe('inside-2')
  })

  test('body overflow is locked while open and restored on close', () => {
    const orig = document.body.style.overflow
    const { unmount } = render(
      <Dialog open onClose={() => {}} title="t">
        body
      </Dialog>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe(orig)
  })
})
