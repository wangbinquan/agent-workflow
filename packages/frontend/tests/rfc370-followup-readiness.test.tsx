// RFC-370: a draft flush may outlive execution readiness. Keep the draft and
// refuse a new followup before its POST; cancellation remains independent.
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import type { HostExecutionStatus } from '@agent-workflow/shared'
import { api } from '../src/api/client'
import { HostExecutionReadinessContext } from '../src/hooks/useHostExecutionAvailability'
import { useClarifyFollowup } from '../src/lib/clarify/useClarifyFollowup'
import '../src/i18n'

vi.mock('../src/api/client', () => ({ api: { post: vi.fn(), delete: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('losing readiness during the original draft flush preserves its writes and prevents the later generation request', async () => {
  let view: HostExecutionStatus = {
    mode: 'execution',
    status: {
      phase: 'active',
      generation: 'original-generation',
      readyGroups: ['task'],
      reason: null,
    },
  }
  let release!: () => void
  const flushed = new Promise<void>((done) => {
    release = done
  })
  let draftWrites = 0
  const refresh = vi.fn(async () => {})
  const { result, rerender } = renderHook(() => useClarifyFollowup('original-round', refresh), {
    wrapper: ({ children }: PropsWithChildren) => (
      <HostExecutionReadinessContext.Provider value={view}>
        {children}
      </HostExecutionReadinessContext.Provider>
    ),
  })
  let failure!: Promise<unknown>
  await act(async () => {
    failure = result.current
      .start(
        { parentQuestionId: 'q', basis: 'basis', instruction: 'preserved direction' },
        async () => {
          await flushed
          draftWrites += 1
        },
      )
      .catch((error) => error)
  })
  expect(result.current.pending).toBe(true)
  view = {
    mode: 'resource-only',
    status: {
      phase: 'standby',
      generation: 'original-generation',
      readyGroups: [],
      reason: 'resource-only',
    },
  }
  rerender()
  await act(async () => {
    release()
    expect(await failure).toBeInstanceOf(Error)
  })
  expect(draftWrites).toBe(1)
  expect(api.post).not.toHaveBeenCalled()
  expect(result.current.pending).toBe(false)
  expect(refresh).toHaveBeenCalledWith('original-round')
  await result.current.cancel()
  expect(api.delete).not.toHaveBeenCalled()
})
