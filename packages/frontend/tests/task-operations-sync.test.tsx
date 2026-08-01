import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let captured: ((message: unknown) => void) | null = null
let connection = { connected: true, connectionEpoch: 1 }

vi.mock('../src/hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (message: unknown) => void }) => {
    captured = onMessage
    return connection
  },
}))

import { useTaskOperationsSync } from '../src/hooks/useTaskOperationsSync'

function wrapper(client: QueryClient): React.FC<{ children: React.ReactNode }> {
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useTaskOperationsSync — stable list reconciliation', () => {
  let client: QueryClient

  beforeEach(() => {
    captured = null
    connection = { connected: true, connectionEpoch: 1 }
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  test.each([
    'task.created',
    'task.status',
    'task.deleted',
    'task.members.changed',
    'lifecycle.alert',
    'lifecycle.alert.resolved',
  ])('%s marks the list dirty without an immediate refetch', async (type) => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const reset = vi.spyOn(client, 'resetQueries')
    const { result } = renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })

    act(() => captured?.({ type, taskId: 'task-1' }))

    await waitFor(() => expect(result.current.dirty).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['task-operations'],
      refetchType: 'none',
    })
    expect(reset).not.toHaveBeenCalled()
  })

  test('explicit refresh reconciles and clears the banner state', async () => {
    const reset = vi.spyOn(client, 'resetQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })
    act(() => captured?.({ type: 'task.status', taskId: 'task-1', status: 'done' }))
    await waitFor(() => expect(result.current.dirty).toBe(true))

    await act(async () => result.current.refresh())

    expect(reset).toHaveBeenCalledWith({ queryKey: ['task-operations'] })
    expect(result.current.dirty).toBe(false)
  })

  test('a reconnect after the first successful connection marks the snapshot dirty', async () => {
    const { result, rerender } = renderHook(() => useTaskOperationsSync(), {
      wrapper: wrapper(client),
    })
    expect(result.current.dirty).toBe(false)

    connection = { connected: false, connectionEpoch: 1 }
    rerender()
    connection = { connected: true, connectionEpoch: 2 }
    rerender()

    await waitFor(() => expect(result.current.dirty).toBe(true))
  })

  test('dirty snapshots auto-refresh after 15 seconds', async () => {
    vi.useFakeTimers()
    const reset = vi.spyOn(client, 'resetQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })
    act(() => captured?.({ type: 'task.created', taskId: 'task-1' }))
    expect(result.current.dirty).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(reset).toHaveBeenCalledWith({ queryKey: ['task-operations'] })
    expect(result.current.dirty).toBe(false)
  })
})
