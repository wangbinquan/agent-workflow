// RFC-099 follow-up — nested <Dialog> regression locks.
//
// User report: "转让所有者的弹窗弹出来后，界面必死" — opening the owner-
// transfer dialog (a Dialog rendered INSIDE the permissions Dialog) froze the
// whole page. Two concurrent focus traps each yanked focus back into their
// own panel, producing a synchronous focusin loop on the main thread. A
// second latent bug: both layers' window-level ESC listeners fired on one
// keypress (stopPropagation does not silence sibling listeners on the same
// node), closing BOTH dialogs at once.
//
// The fix is the module-level open-dialog stack in Dialog.tsx: only the
// TOPMOST dialog runs its trap and answers ESC. These tests lock:
//   1. focus placed inside the inner dialog STAYS there (outer trap inert);
//   2. first Escape closes only the inner dialog, second closes the outer;
//   3. closing the inner hands focus restoration back without re-freezing.

import { StrictMode, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { Dialog, __testAcquireDialogBodyScrollLock } from '../src/components/Dialog'
import '../src/i18n'

afterEach(() => cleanup())

function NestedHarness() {
  const [outerOpen, setOuterOpen] = useState(true)
  const [innerOpen, setInnerOpen] = useState(false)
  const innerInputRef = useRef<HTMLInputElement | null>(null)
  return (
    <Dialog open={outerOpen} onClose={() => setOuterOpen(false)} title="outer">
      <button type="button" data-testid="open-inner" onClick={() => setInnerOpen(true)}>
        open inner
      </button>
      <Dialog
        open={innerOpen}
        onClose={() => setInnerOpen(false)}
        title="inner"
        size="sm"
        initialFocusRef={innerInputRef}
      >
        <input ref={innerInputRef} data-testid="inner-input" />
      </Dialog>
    </Dialog>
  )
}

function ConcurrentHarness({ firstOpen, secondOpen }: { firstOpen: boolean; secondOpen: boolean }) {
  return (
    <>
      <Dialog open={firstOpen} onClose={() => {}} title="first">
        <button type="button">first action</button>
      </Dialog>
      <Dialog open={secondOpen} onClose={() => {}} title="second">
        <button type="button">second action</button>
      </Dialog>
    </>
  )
}

describe('nested Dialog — open-dialog stack (RFC-099 freeze regression)', () => {
  test('focus inside the inner dialog is NOT yanked back by the outer trap', async () => {
    render(<NestedHarness />)
    fireEvent.click(screen.getByTestId('open-inner'))
    const input = await screen.findByTestId('inner-input')
    input.focus()
    // Let the outer dialog's focusout microtask + any pending timers settle —
    // pre-fix this is exactly where the two traps started fighting.
    await new Promise((r) => setTimeout(r, 20))
    expect(document.activeElement).toBe(input)
  })

  test('Escape closes ONLY the top dialog; a second Escape closes the outer', async () => {
    render(<NestedHarness />)
    fireEvent.click(screen.getByTestId('open-inner'))
    await screen.findByTestId('inner-input')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('inner-input')).toBeNull())
    // Outer dialog survived the first Escape.
    expect(screen.queryByTestId('open-inner')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('open-inner')).toBeNull())
  })

  test('focus moving WITHIN the dialog (× → input) is not stolen by the focusout net', async () => {
    // Regression: the focusout microtask ran between the native blur and
    // focus of an in-dialog click, saw activeElement=<body>, and yanked
    // focus to the × button — eating clicks on inputs inside dialogs
    // ("搜索用户那个textbox无法使用" root cause #2).
    render(<NestedHarness />)
    fireEvent.click(screen.getByTestId('open-inner'))
    const input = await screen.findByTestId('inner-input')
    const closeBtn = document.querySelector('.dialog__panel:last-of-type .dialog__close')!
    // Simulate the mid-flight state: × loses focus toward the input.
    fireEvent.focusOut(closeBtn, { relatedTarget: input })
    input.focus()
    await new Promise((r) => setTimeout(r, 20))
    expect(document.activeElement).toBe(input)
  })

  test('after the inner closes, the outer trap is live again (single-dialog behavior restored)', async () => {
    render(<NestedHarness />)
    fireEvent.click(screen.getByTestId('open-inner'))
    await screen.findByTestId('inner-input')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('inner-input')).toBeNull())
    // Park focus outside the dialog; the (now top-of-stack) outer trap must
    // pull it back inside its panel.
    const outsider = document.createElement('button')
    document.body.appendChild(outsider)
    outsider.focus()
    await new Promise((r) => setTimeout(r, 20))
    const active = document.activeElement
    expect(active).not.toBe(outsider)
    outsider.remove()
  })
})

describe('concurrent Dialog — shared body scroll lock', () => {
  test('closing the older dialog first stays locked until the final owner restores the first value', () => {
    const beforeTest = document.body.style.overflow
    document.body.style.overflow = 'clip'
    try {
      const { rerender } = render(<ConcurrentHarness firstOpen secondOpen />)
      expect(document.body.style.overflow).toBe('hidden')

      // A closes out of order while B remains open: the page must stay locked.
      rerender(<ConcurrentHarness firstOpen={false} secondOpen />)
      expect(document.body.style.overflow).toBe('hidden')

      // The final owner restores the value captured before A opened, not the
      // `hidden` value B observed when it joined the shared lock.
      rerender(<ConcurrentHarness firstOpen={false} secondOpen={false} />)
      expect(document.body.style.overflow).toBe('clip')
    } finally {
      cleanup()
      document.body.style.overflow = beforeTest
    }
  })

  test('StrictMode replay and a repeated stale cleanup never release a live owner', () => {
    const beforeTest = document.body.style.overflow
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    document.body.style.overflow = 'scroll'
    try {
      const { rerender, unmount } = render(
        <StrictMode>
          <ConcurrentHarness firstOpen secondOpen />
        </StrictMode>,
      )
      expect(document.body.style.overflow).toBe('hidden')

      rerender(
        <StrictMode>
          <ConcurrentHarness firstOpen={false} secondOpen />
        </StrictMode>,
      )
      expect(document.body.style.overflow).toBe('hidden')
      unmount()
      expect(document.body.style.overflow).toBe('scroll')

      // Exercise the release token itself across lock sessions: once the first
      // owner fully releases, a late duplicate cleanup cannot decrement the
      // new session's owner.
      releaseFirst = __testAcquireDialogBodyScrollLock()
      expect(document.body.style.overflow).toBe('hidden')
      releaseFirst()
      expect(document.body.style.overflow).toBe('scroll')
      releaseSecond = __testAcquireDialogBodyScrollLock()
      expect(document.body.style.overflow).toBe('hidden')
      releaseFirst()
      expect(document.body.style.overflow).toBe('hidden')
      releaseSecond()
      expect(document.body.style.overflow).toBe('scroll')
    } finally {
      releaseFirst?.()
      releaseSecond?.()
      cleanup()
      document.body.style.overflow = beforeTest
    }
  })
})
