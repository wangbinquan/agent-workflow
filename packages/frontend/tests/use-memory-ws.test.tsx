// RFC-041 PR4 — useMemoryWs hook contract.
//
// /ws/memories carries memory.* events. Hook invalidates:
//   ['memories','pending-count'], ['memories','candidates'],
//   ['memories','all'], ['memories','scoped'], ['memories','detail', id]
//
// MockSocket pattern follows use-clarify-ws.test.tsx.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, act } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useMemoryWs } from '../src/hooks/useMemoryWs'

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

function Probe() {
  useMemoryWs()
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

describe('useMemoryWs', () => {
  test('memory.candidate.created invalidates list + pending-count + detail', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(MockSocket.instances.length).toBeGreaterThanOrEqual(1)
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireOpen()
      sock.fireMessage({
        type: 'memory.candidate.created',
        memory: {
          id: 'mem_new1',
          scopeType: 'workflow',
          scopeId: 'wf_a',
          title: 'X',
          status: 'candidate',
          tags: [],
          approvedAt: null,
          version: 1,
          distillAction: 'new',
        },
      })
    })
    const keys = invalidateSpy.mock.calls
      .map((c) => JSON.stringify((c[0] as { queryKey?: unknown[] }).queryKey ?? []))
      .filter((s) => s.includes('memories'))
    expect(keys.some((k) => k.includes('"pending-count"'))).toBe(true)
    expect(keys.some((k) => k.includes('"candidates"'))).toBe(true)
    expect(keys.some((k) => k.includes('"all"'))).toBe(true)
    expect(keys.some((k) => k.includes('"detail"') && k.includes('mem_new1'))).toBe(true)
  })

  test('memory.archived invalidates by memoryId', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 0))
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireOpen()
      sock.fireMessage({ type: 'memory.archived', memoryId: 'mem_arch_77' })
    })
    const keys = invalidateSpy.mock.calls
      .map((c) => JSON.stringify((c[0] as { queryKey?: unknown[] }).queryKey ?? []))
      .filter((s) => s.includes('memories'))
    expect(keys.some((k) => k.includes('mem_arch_77'))).toBe(true)
  })

  test('non-memory messages are ignored', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 0))
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireOpen()
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['memories', 'pending-count'] })
    invalidateSpy.mockClear()
    act(() => {
      sock.fireMessage({ type: 'task.something-else', payload: 1 })
    })
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
