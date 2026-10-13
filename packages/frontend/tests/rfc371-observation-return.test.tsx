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
  const [background, setBackground] = useState(false)
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
            <button onClick={() => setBackground(true)}>Mount background cards</button>
            {background && <div data-restored-background>Full background</div>}
            <button
              data-observation-dimension="runtime:original-runtime"
              onClick={() => setMounted(true)}
            >
              Mount contributions
            </button>
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

test('a returned portal cannot consume the main offset while background cards are still too short', async () => {
  render(<DelayedContributions />)
  const main = document.querySelector('main')!
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 500 })
  Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 4000 })
  main.scrollTop = 3000
  fireEvent.click(screen.getByRole('button', { name: 'Child task' }))
  Object.defineProperty(main, 'scrollHeight', {
    configurable: true,
    get: () => (document.querySelector('[data-restored-background]') ? 4000 : 700),
  })
  main.scrollTop = 0
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mount contributions' }))
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  expect(main.scrollTop).toBe(0)
  const restored = screen.getByRole('button', { name: 'Child task' })
  expect(document.activeElement).not.toBe(restored)
  fireEvent.click(screen.getByRole('button', { name: 'Mount background cards' }))
  await waitFor(() => expect(document.activeElement).toBe(restored))
  expect(main.scrollTop).toBe(3000)
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
