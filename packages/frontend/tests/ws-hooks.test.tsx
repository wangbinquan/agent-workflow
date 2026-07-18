// Sanity check the WS hooks by stubbing the global WebSocket and asserting
// the hook subscribes / unsubscribes correctly. Network-level reconnect is
// tested by the backend ws.test.ts; here we only need to assert the React
// integration.

import { useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useTasksSync } from '../src/hooks/useTasksSync'
import { useWorkflowSync } from '../src/hooks/useWorkflowSync'

const WORKFLOW_MUTATION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORKFLOW_SNAPSHOT_HASH = 'a'.repeat(64)

function workflowUpdatedFrame(workflowId: string, version: number) {
  return {
    type: 'workflow.updated',
    workflowId,
    clientMutationId: WORKFLOW_MUTATION_ID,
    version,
    snapshotHash: WORKFLOW_SNAPSHOT_HASH,
    updatedAt: 1_720_000_000_000,
  }
}

let opened: MockWebSocket[] = []

// vitest 4 + happy-dom 20: a `vi.fn((url) => objectLiteral)` used as a
// constructor is no longer honored — `new WebSocket()` discarded the returned
// object, so the tracked `opened` array stayed empty and every assertion read
// `undefined`. A real class whose constructor records `this` is the
// version-robust shape (mirrors the already-passing use-clarify-ws.test.tsx).
class MockWebSocket {
  url: string
  readyState = 0
  listeners: Record<string, Array<(e: MessageEvent | Event) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  }
  constructor(url: string) {
    this.url = url
    opened.push(this)
    // Auto-fire open on next microtask (mirrors the real handshake).
    Promise.resolve().then(() => {
      this.fireOpen()
    })
  }
  addEventListener(event: string, fn: (e: MessageEvent | Event) => void): void {
    ;(this.listeners[event] ??= []).push(fn)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
    for (const l of this.listeners.close ?? []) l(new Event('close'))
  }
  fireOpen(): void {
    this.readyState = 1
    for (const l of this.listeners.open ?? []) l(new Event('open'))
  }
  fireClose(): void {
    this.close()
  }
  fireMessage(msg: unknown): void {
    for (const l of this.listeners.message ?? []) {
      l({ data: JSON.stringify(msg) } as MessageEvent)
    }
  }
}

beforeEach(() => {
  opened = []
  // vi.stubGlobal installs the mock on the env global the module-under-test
  // resolves bare `WebSocket` against; vi.unstubAllGlobals restores it.
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function renderHook(useHook: () => void) {
  const client = new QueryClient()
  function Host() {
    useHook()
    return null
  }
  return render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  )
}

describe('useTasksSync', () => {
  test('opens a /ws/tasks connection with the stored token', () => {
    renderHook(() => useTasksSync())
    expect(opened.length).toBe(1)
    expect(opened[0]?.url).toContain('/ws/tasks?token=tok')
  })

  test('invalidates ["tasks"] on task.status', async () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    function Host() {
      const qc = useQueryClient()
      void qc
      useTasksSync()
      return null
    }
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    )
    // Find the WS instance opened by this render.
    const ws = opened[opened.length - 1]!
    for (const l of ws.listeners.message ?? []) {
      l({
        data: JSON.stringify({ type: 'task.status', taskId: 'x', status: 'done' }),
      } as MessageEvent)
    }
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }))
  })

  test('reconciles the task list as soon as the lossy notification socket opens', async () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    function Host() {
      useTasksSync()
      return null
    }
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] })
  })
})

describe('useWorkflowSync', () => {
  test('opens /ws/workflows even when no workflowId yet', () => {
    renderHook(() => useWorkflowSync({ workflowId: null, currentVersion: null }))
    expect(opened[0]?.url).toContain('/ws/workflows')
  })

  test('fires onRemoteUpdate only for matching id with strictly newer version', () => {
    const onRemote = vi.fn()
    renderHook(() =>
      useWorkflowSync({
        workflowId: 'wf-1',
        currentVersion: 3,
        onRemoteUpdate: onRemote,
      }),
    )
    const ws = opened[opened.length - 1]!
    function fire(msg: unknown) {
      for (const l of ws.listeners.message ?? []) l({ data: JSON.stringify(msg) } as MessageEvent)
    }
    fire(workflowUpdatedFrame('other', 99))
    fire(workflowUpdatedFrame('wf-1', 3))
    fire(workflowUpdatedFrame('wf-1', 4))
    expect(onRemote).toHaveBeenCalledTimes(1)
    expect(onRemote).toHaveBeenCalledWith(4)
  })

  test('fires onRemoteDelete when our workflow is deleted', () => {
    const onDelete = vi.fn()
    renderHook(() =>
      useWorkflowSync({
        workflowId: 'wf-1',
        currentVersion: 1,
        onRemoteDelete: onDelete,
      }),
    )
    const ws = opened[opened.length - 1]!
    for (const l of ws.listeners.message ?? []) {
      l({
        data: JSON.stringify({
          type: 'workflow.deleted',
          workflowId: 'wf-1',
          clientMutationId: WORKFLOW_MUTATION_ID,
          deletedVersion: 1,
        }),
      } as MessageEvent)
    }
    expect(onDelete).toHaveBeenCalled()
  })

  test('every real open exposes a monotonic epoch and unconditionally reconciles detail + list', async () => {
    vi.useFakeTimers()
    try {
      const client = new QueryClient()
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      let latest = { connected: false, connectionEpoch: 0 }
      function Host() {
        latest = useWorkflowSync({
          workflowId: 'wf-1',
          currentVersion: 7,
          // An own in-flight mutation may suppress its echo frame's detail
          // invalidation, but must never suppress open-time reconciliation.
          inFlightMutationId: WORKFLOW_MUTATION_ID,
        })
        return null
      }
      render(
        <QueryClientProvider client={client}>
          <Host />
        </QueryClientProvider>,
      )

      await act(async () => {
        await Promise.resolve()
      })
      expect(latest).toEqual({ connected: true, connectionEpoch: 1 })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows', 'wf-1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows'] })

      invalidate.mockClear()
      act(() => opened[0]!.fireClose())
      expect(latest.connected).toBe(false)
      act(() => vi.advanceTimersByTime(500))
      await act(async () => {
        await Promise.resolve()
      })
      expect(opened).toHaveLength(2)
      expect(latest).toEqual({ connected: true, connectionEpoch: 2 })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows', 'wf-1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows'] })
    } finally {
      vi.useRealTimers()
    }
  })

  test('auth rotation increments the epoch and a late subscriber observes the already-open epoch', async () => {
    let first = { connected: false, connectionEpoch: 0 }
    let second = { connected: false, connectionEpoch: 0 }
    function First() {
      first = useWorkflowSync({ workflowId: 'wf-1', currentVersion: 1 })
      return null
    }
    function Second() {
      second = useWorkflowSync({ workflowId: 'wf-1', currentVersion: 1 })
      return null
    }

    render(<First />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(first).toEqual({ connected: true, connectionEpoch: 1 }))

    act(() => setToken('rotated'))
    await waitFor(() => expect(first).toEqual({ connected: true, connectionEpoch: 2 }))
    expect(opened).toHaveLength(2)

    render(<Second />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(second).toEqual({ connected: true, connectionEpoch: 2 }))
    expect(opened).toHaveLength(2)
  })

  test('own update still emits its full frame and invalidates list, but not detail', async () => {
    const ownFrame = workflowUpdatedFrame('wf-1', 4)
    const onFrame = vi.fn()
    const onRemote = vi.fn()
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    function Host() {
      useWorkflowSync({
        workflowId: 'wf-1',
        currentVersion: 3,
        inFlightMutationId: WORKFLOW_MUTATION_ID,
        onFrame,
        onRemoteUpdate: onRemote,
      })
      return null
    }
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    invalidate.mockClear()

    act(() => opened[0]!.fireMessage(ownFrame))

    expect(onFrame).toHaveBeenCalledWith(ownFrame)
    expect(onRemote).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows'] })
  })

  test('foreign newer update emits its full frame and invalidates detail + list', async () => {
    const foreignFrame = {
      ...workflowUpdatedFrame('wf-1', 4),
      clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    }
    const onFrame = vi.fn()
    const onRemote = vi.fn()
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    function Host() {
      useWorkflowSync({
        workflowId: 'wf-1',
        currentVersion: 3,
        inFlightMutationId: WORKFLOW_MUTATION_ID,
        onFrame,
        onRemoteUpdate: onRemote,
      })
      return null
    }
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    invalidate.mockClear()

    act(() => opened[0]!.fireMessage(foreignFrame))

    expect(onFrame).toHaveBeenCalledWith(foreignFrame)
    expect(onRemote).toHaveBeenCalledWith(4)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows', 'wf-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows'] })
  })

  test('delete emits the complete frame even when it carries our own mutation id', () => {
    const deletedFrame = {
      type: 'workflow.deleted' as const,
      workflowId: 'wf-1',
      clientMutationId: WORKFLOW_MUTATION_ID,
      deletedVersion: 8,
    }
    const onFrame = vi.fn()
    const onDelete = vi.fn()
    renderHook(() =>
      useWorkflowSync({
        workflowId: 'wf-1',
        currentVersion: 7,
        inFlightMutationId: WORKFLOW_MUTATION_ID,
        onFrame,
        onRemoteDelete: onDelete,
      }),
    )

    act(() => opened[0]!.fireMessage(deletedFrame))

    expect(onFrame).toHaveBeenCalledWith(deletedFrame)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
