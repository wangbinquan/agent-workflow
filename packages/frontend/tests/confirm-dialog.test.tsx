// RFC-198 — ConfirmDialog transactional pending/error/focus contract.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState, type ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ConfirmDialog } from '../src/components/ConfirmDialog'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('<ConfirmDialog />', () => {
  test('open=false renders no dialog', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Delete agent"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('renders description, labels and default/danger action hierarchy', () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Apply changes"
        description={<p>Update the provider configuration?</p>}
        confirmLabel="Apply"
        cancelLabel="Keep editing"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Apply changes' })).not.toBeNull()
    expect(screen.getByText('Update the provider configuration?').parentElement?.className).toBe(
      'confirm-dialog__description',
    )
    expect(screen.getByRole('button', { name: 'Keep editing' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' }).className).toBe('btn btn--primary')

    rerender(
      <ConfirmDialog
        open
        title="Delete agent"
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Delete' }).className).toBe('btn btn--danger')
  })

  test('single-fires and blocks every dismiss path while confirmation is pending', async () => {
    const task = deferred<void>()
    const onConfirm = vi.fn(() => task.promise)
    const onClose = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Delete provider"
        description="Delete this provider?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(cancel.disabled).toBe(true)
    expect((document.querySelector('.dialog__close') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('dialog').className).toContain('confirm-dialog--pending')

    fireEvent.click(cancel)
    fireEvent.click(document.querySelector('.dialog__close') as HTMLElement)
    fireEvent.mouseDown(document.querySelector('.dialog__overlay') as HTMLElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      task.resolve(undefined)
      await task.promise
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('reject keeps the dialog open, exposes ErrorBanner, resets pending and permits retry', async () => {
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Provider is still in use'))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Delete provider"
        description="Delete this provider?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    fireEvent.click(confirm)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Provider is still in use')
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(confirm.disabled).toBe(false)
    expect(confirm.getAttribute('aria-busy')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(confirm)
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  test('a new open session clears the previous rejection', async () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Delete provider"
        description="Delete this provider?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => Promise.reject(new Error('Temporary failure'))}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).not.toBeNull()

    rerender(
      <ConfirmDialog
        open={false}
        title="Delete provider"
        description="Delete this provider?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    rerender(
      <ConfirmDialog
        open
        title="Delete provider"
        description="Delete this provider?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  test('falls back to a stable focus target when the original trigger unmounts', async () => {
    let disconnectTrigger = (): void => {}

    function Probe(): ReactElement {
      const triggerRef = useRef<HTMLButtonElement | null>(null)
      const fallbackRef = useRef<HTMLButtonElement | null>(null)
      const [open, setOpen] = useState(false)
      const [showTrigger, setShowTrigger] = useState(true)
      disconnectTrigger = () => setShowTrigger(false)

      return (
        <>
          {showTrigger && (
            <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
              Open confirmation
            </button>
          )}
          <button ref={fallbackRef} type="button">
            Stable fallback
          </button>
          <ConfirmDialog
            open={open}
            title="Delete provider"
            description="Delete this provider?"
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onConfirm={() => {}}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
            restoreFocusFallbackRef={fallbackRef}
          />
        </>
      )
    }

    render(<Probe />)
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    act(() => disconnectTrigger())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stable fallback' })),
    )
  })
})

// RFC-222 (D5, F-5/F-6) — type-to-confirm mode.
describe('<ConfirmDialog /> type-to-confirm', () => {
  function renderTTC(onConfirm: (ctx?: { typedConfirm?: string }) => void | Promise<void>) {
    return render(
      <ConfirmDialog
        open
        title="Delete my-agent?"
        description="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        confirmInput={{ expected: 'my-agent', label: 'Type my-agent to confirm' }}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
  }

  test('confirm button is disabled until the input EXACTLY matches (trim-tolerant)', () => {
    renderTTC(() => {})
    const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    const input = screen.getByTestId('confirm-input') as HTMLInputElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'my-age' } })
    expect(btn.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'My-Agent' } }) // case-sensitive
    expect(btn.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  my-agent  ' } }) // trimmed → match
    expect(btn.disabled).toBe(false)
  })

  test('submits the user’s ACTUAL typed text (trimmed), never the expected constant', async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    renderTTC(onConfirm)
    fireEvent.change(screen.getByTestId('confirm-input'), { target: { value: ' my-agent ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledWith({ typedConfirm: 'my-agent' })
  })

  test('a keyboard Enter cannot bypass a non-matching input', () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    renderTTC(onConfirm)
    const input = screen.getByTestId('confirm-input')
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('reopening clears the previous input', () => {
    const { rerender } = renderTTC(() => {})
    const input = () => screen.getByTestId('confirm-input') as HTMLInputElement
    fireEvent.change(input(), { target: { value: 'my-agent' } })
    expect(input().value).toBe('my-agent')
    rerender(
      <ConfirmDialog
        open={false}
        title="Delete my-agent?"
        description="x"
        confirmLabel="Delete"
        confirmInput={{ expected: 'my-agent', label: 'Type my-agent to confirm' }}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    rerender(
      <ConfirmDialog
        open
        title="Delete my-agent?"
        description="x"
        confirmLabel="Delete"
        confirmInput={{ expected: 'my-agent', label: 'Type my-agent to confirm' }}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    expect(input().value).toBe('')
  })
})
