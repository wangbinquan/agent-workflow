// RFC-023 PR-C T24 — useClarifyWs hook contract.
//
// The hook subscribes to /ws/tasks/{taskId} and on clarify.created /
// clarify.answered events invalidates three react-query keys:
//   ['clarify','detail', nodeRunId] (only when focused on a specific session)
//   ['clarify','list']
//   ['clarify','pending-count']
//
// We mock the global WebSocket constructor so the hook believes it has a
// live connection, then simulate a message and assert the invalidations
// reached the QueryClient.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, act } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useClarifyWs } from '../src/hooks/useClarifyWs'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    open: [],
    close: [],
    error: [],
  }
  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).concat(fn)
  }
  removeEventListener(): void {}
  close(): void {
    for (const fn of this.listeners.close ?? []) fn(null)
  }
  fireMessage(data: unknown): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) })
  }
  fireOpen(): void {
    for (const fn of this.listeners.open ?? []) fn(null)
  }
}

const RealWebSocket = globalThis.WebSocket

function Probe({ taskId, nodeRunId }: { taskId: string | null; nodeRunId: string | null }) {
  useClarifyWs({ taskId, intermediaryNodeRunId: nodeRunId })
  return null
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  MockSocket.instances = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = MockSocket as unknown as typeof WebSocket
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = RealWebSocket
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useClarifyWs', () => {
  test('clarify.answered invalidates the three query keys', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    render(
      <QueryClientProvider client={qc}>
        <Probe taskId="task_a" nodeRunId="nr_clarify" />
      </QueryClientProvider>,
    )
    // Wait for the hook to mount and open the WS.
    await new Promise((r) => setTimeout(r, 0))
    expect(MockSocket.instances.length).toBeGreaterThanOrEqual(1)
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireOpen()
      sock.fireMessage({
        id: 1,
        type: 'clarify.answered',
        nodeRunId: 'nr_clarify',
        clarifyNodeId: 'c1',
        sourceShardKey: null,
        iterationIndex: 0,
        rerunNodeRunId: 'nr_rerun',
        session: { id: 's', status: 'answered' },
      })
    })
    const keys = invalidateSpy.mock.calls
      .map((c) => JSON.stringify((c[0] as { queryKey?: unknown[] }).queryKey ?? []))
      .filter((s) => s.includes('clarify'))
    expect(keys.some((k) => k.includes('"detail"') && k.includes('nr_clarify'))).toBe(true)
    expect(keys.some((k) => k.includes('"list"'))).toBe(true)
    expect(keys.some((k) => k.includes('"pending-count"'))).toBe(true)
  })
})
