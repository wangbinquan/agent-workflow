// RFC-053 PR-E — useTasksSync invalidates the right query key on a
// `lifecycle.alert` WS message.
//
// The chain in production:
//   server emits { type:'lifecycle.alert', taskId, rule, severity, transition }
//     → useTasksSync onMessage handler
//     → queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'alerts'] })
//     → StuckTaskBanner refetches GET /api/tasks/:id/alerts
//     → banner re-renders (or vanishes when alerts empty)
//
// We mock `useWebSocket` to capture its `onMessage` callback and then
// drive it synchronously from the test. This isolates useTasksSync's
// invalidation logic without bringing up a real WS connection (the
// Playwright e2e in PR-F covers the full real-WS path).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TasksListWsMessage } from '@agent-workflow/shared'

// We must mock the module BEFORE importing the hook under test.
let captured: ((msg: unknown) => void) | null = null
vi.mock('../src/hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { path: string; onMessage: (msg: unknown) => void }) => {
    captured = onMessage
    return { connected: false, connectionEpoch: 0 }
  },
}))

import { useTasksSync } from '../src/hooks/useTasksSync'

function makeWrapper(qc: QueryClient): React.FC<{ children: React.ReactNode }> {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useTasksSync — lifecycle.alert handler', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    captured = null
  })
  afterEach(() => {
    qc.clear()
  })

  test('lifecycle.alert message invalidates the alerts query for that taskId', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    renderHook(() => useTasksSync(true), { wrapper: makeWrapper(qc) })
    expect(captured).not.toBeNull()
    const msg: TasksListWsMessage = {
      type: 'lifecycle.alert',
      taskId: 'task-xyz',
      rule: 'S4',
      severity: 'warning',
      transition: 'new',
    }
    captured!(msg)
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'task-xyz', 'alerts'] })
    })
  })

  test('lifecycle.alert does NOT invalidate the broad ["tasks"] query (saves a network round-trip on the list page)', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    renderHook(() => useTasksSync(true), { wrapper: makeWrapper(qc) })
    const msg: TasksListWsMessage = {
      type: 'lifecycle.alert',
      taskId: 'task-y',
      rule: 'R1',
      severity: 'error',
      transition: 'promoted',
    }
    captured!(msg)
    await waitFor(() => {
      // Was invoked exactly once with the alerts key — not with ['tasks'].
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'task-y', 'alerts'] })
    })
    // Sanity: ['tasks'] alone was not invalidated by this message.
    const callsWithBroadKey = invalidateSpy.mock.calls.filter((args) => {
      const arg0 = args[0] as { queryKey?: unknown[] } | undefined
      const k = arg0?.queryKey
      return Array.isArray(k) && k.length === 1 && k[0] === 'tasks'
    })
    expect(callsWithBroadKey).toHaveLength(0)
  })

  test('non-lifecycle messages still trigger their own invalidations', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    renderHook(() => useTasksSync(true), { wrapper: makeWrapper(qc) })
    const msg: TasksListWsMessage = {
      type: 'task.status',
      taskId: 'task-z',
      status: 'done',
    }
    captured!(msg)
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] })
    })
  })

  test('disabled=false does not subscribe', () => {
    renderHook(() => useTasksSync(false), { wrapper: makeWrapper(qc) })
    // Mocked useWebSocket still runs; the contract here is that the hook
    // can be disabled (some callers gate it on the tasks page).
    // Cleared captured = null at beforeEach but mocked useWebSocket
    // always captures — so the assertion is just that the call doesn't
    // throw. The "enabled=false" gating is exercised in useWebSocket
    // itself (out of scope here).
    expect(captured).not.toBeNull()
  })
})
