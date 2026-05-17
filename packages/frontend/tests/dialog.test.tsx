// RFC-035 PR3 — render matrix + a11y for the shared <Dialog>.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import type { ReactElement } from 'react'
import { Dialog } from '../src/components/Dialog'

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
