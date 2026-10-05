// RFC-371: retain the source position when a contribution portal mounts after the ready parent.
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useObservationReturn } from '../src/hooks/useObservationReturn'
import { resolveInitialDialogFocus } from '../src/components/Dialog'

afterEach(cleanup)
function DelayedContributions() {
  const page = useRef<HTMLDivElement>(null)
  const [task, setTask] = useState<string>()
  const [mounted, setMounted] = useState(true)
  const save = useObservationReturn('same-parent-report', task, page, !task)
  return (
    <main>
      <div ref={page}>
        {task ? (
          <button
            onClick={() => {
              setMounted(false)
              setTask(undefined)
            }}
          >
            Back
          </button>
        ) : (
          <>
            <button onClick={() => setMounted(true)}>Mount contributions</button>
            {mounted ? (
              <div role="dialog">
                <div className="dialog__body">
                  <div data-observation-contributions="runtime:original-runtime">
                    <button>Related tasks</button>
                    <button
                      data-observation-task="child"
                      onClick={(event) => {
                        save('child', event.currentTarget)
                        setTask('child')
                      }}
                    >
                      Child task
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}

test('two ready frames cannot consume a return position before its real dialog row mounts', async () => {
  render(<DelayedContributions />)
  document.querySelector<HTMLElement>('.dialog__body')!.scrollTop = 137
  fireEvent.click(screen.getByRole('button', { name: 'Child task' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Mount contributions' }))
  const restored = screen.getByRole('button', { name: 'Child task' })
  await waitFor(() => expect(document.activeElement).toBe(restored))
  expect(document.querySelector<HTMLElement>('.dialog__body')!.scrollTop).toBe(137)
})

// CI 37346463785: the shared initial-focus callback ran after return restoration
// and selected Related tasks instead of the source row. Do not depend on timer order.
test('a late shared Dialog initial-focus callback keeps the restored task row', async () => {
  render(<DelayedContributions />)
  document.querySelector<HTMLElement>('.dialog__body')!.scrollTop = 137
  fireEvent.click(screen.getByRole('button', { name: 'Child task' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mount contributions' }))
  const restored = screen.getByRole('button', { name: 'Child task' })
  await waitFor(() => expect(document.activeElement).toBe(restored))
  const lateTarget = resolveInitialDialogFocus(screen.getByRole('dialog'), null)
  expect(lateTarget).toBe(restored)
  lateTarget.focus({ preventScroll: true })
  expect(document.activeElement).toBe(restored)
  expect(document.querySelector<HTMLElement>('.dialog__body')!.scrollTop).toBe(137)
})
