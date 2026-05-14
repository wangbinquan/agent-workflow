// Sanity check the WS hooks by stubbing the global WebSocket and asserting
// the hook subscribes / unsubscribes correctly. Network-level reconnect is
// tested by the backend ws.test.ts; here we only need to assert the React
// integration.

import { useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useTasksSync } from '../src/hooks/useTasksSync'
import { useWorkflowSync } from '../src/hooks/useWorkflowSync'

const realWs = globalThis.WebSocket

interface FakeWs {
  url: string
  listeners: Record<string, Array<(e: MessageEvent | Event) => void>>
  send(): void
  close(): void
}

function fakeWebSocketCtor(url: string): FakeWs {
  const ws: FakeWs = {
    url,
    listeners: { open: [], message: [], close: [], error: [] },
    send() {},
    close() {
      for (const l of ws.listeners.close ?? []) l(new Event('close'))
    },
  }
  // Auto-fire open on next microtask.
  Promise.resolve().then(() => {
    for (const l of ws.listeners.open ?? []) l(new Event('open'))
  })
  ;(
    ws as unknown as {
      addEventListener: (e: string, fn: (m: MessageEvent | Event) => void) => void
    }
  ).addEventListener = (event: string, fn: (m: MessageEvent | Event) => void) => {
    const list = ws.listeners[event] ?? []
    list.push(fn)
    ws.listeners[event] = list
  }
  return ws
}

let opened: FakeWs[]
beforeEach(() => {
  opened = []
  // @ts-expect-error replace with a fake that just tracks instances
  globalThis.WebSocket = vi.fn((url: string) => {
    const ws = fakeWebSocketCtor(url)
    opened.push(ws)
    return ws
  })
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  globalThis.WebSocket = realWs
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
    fire({ type: 'workflow.updated', workflowId: 'other', version: 99, updatedAt: 0 })
    fire({ type: 'workflow.updated', workflowId: 'wf-1', version: 3, updatedAt: 0 })
    fire({ type: 'workflow.updated', workflowId: 'wf-1', version: 4, updatedAt: 0 })
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
      l({ data: JSON.stringify({ type: 'workflow.deleted', workflowId: 'wf-1' }) } as MessageEvent)
    }
    expect(onDelete).toHaveBeenCalled()
  })
})
