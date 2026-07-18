// RFC-152 — useWsInvalidation contract:
//
//   1. rules table dispatch: rules[msg.type] returns query keys →
//      one invalidateQueries per key; void return = side-effect-only rule
//      (the slot carrying useWorkflowSync's version gate and useClarifyWs's
//      onDraftUpdated); unmatched types are ignored.
//   2. socket sharing (D5): two hooks on the SAME path ride ONE physical
//      WebSocket (refcounted) — the mock constructor count is the oracle.
//      Releasing one subscriber keeps the socket; releasing the last closes
//      it. Different paths get different sockets.
//   3. path === null ⇒ no subscription.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, act } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useWsInvalidation, type WsInvalidationRules } from '../src/hooks/useWsInvalidation'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  closed = false
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
    this.closed = true
    for (const fn of this.listeners.close ?? []) fn(null)
  }
  fireMessage(data: unknown): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) })
  }
}

const RealWebSocket = globalThis.WebSocket

type ProbeMsg = { type: 'ping'; n: number } | { type: 'side'; payload: string } | { type: 'zap' }

function Probe({
  path,
  rules,
  reconcileKeys,
}: {
  path: string | null
  rules: WsInvalidationRules<ProbeMsg>
  reconcileKeys?: readonly (readonly unknown[])[]
}) {
  useWsInvalidation<ProbeMsg>(
    path,
    rules,
    undefined,
    reconcileKeys === undefined
      ? undefined
      : { reconcileOnOpen: () => reconcileKeys as readonly (readonly string[])[] },
  )
  return null
}

function mountProbe(
  path: string | null,
  rules: WsInvalidationRules<ProbeMsg>,
  reconcileKeys?: readonly (readonly unknown[])[],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
  const utils = render(
    <QueryClientProvider client={qc}>
      <Probe path={path} rules={rules} reconcileKeys={reconcileKeys} />
    </QueryClientProvider>,
  )
  return { qc, invalidateSpy, ...utils }
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
  vi.restoreAllMocks()
})

describe('useWsInvalidation — rules table dispatch', () => {
  test('every physical open reconciles configured queries even when no frame arrives', () => {
    const { invalidateSpy } = mountProbe('/ws/probe', {}, [['surface'], ['surface', 'detail']])
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!

    act(() => {
      for (const fn of sock.listeners.open ?? []) fn(null)
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['surface'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['surface', 'detail'] })
  })

  test('rule returning keys invalidates each; unmatched types are ignored', () => {
    const { invalidateSpy } = mountProbe('/ws/probe', {
      ping: (msg) => [['a'], ['b', msg.n]],
    })
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireMessage({ type: 'ping', n: 7 })
      sock.fireMessage({ type: 'zap' })
      sock.fireMessage({ type: 'unknown-type' })
      sock.fireMessage('not-an-object')
    })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['a'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['b', 7] })
  })

  test('void rule is side-effect-only (no invalidation)', () => {
    const side = vi.fn()
    const { invalidateSpy } = mountProbe('/ws/probe', {
      side: (msg) => {
        side(msg.payload)
      },
    })
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!
    act(() => {
      sock.fireMessage({ type: 'side', payload: 'fx' })
    })
    expect(side).toHaveBeenCalledWith('fx')
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  test('path null ⇒ no socket at all', () => {
    mountProbe(null, { ping: () => [['a']] })
    expect(MockSocket.instances.length).toBe(0)
  })
})

describe('useWsInvalidation — same-path socket sharing (D5 refcount)', () => {
  test('two rule sets on one path share ONE socket and both dispatch', () => {
    const a = mountProbe('/ws/shared', { ping: () => [['from-a']] })
    const b = mountProbe('/ws/shared', { ping: () => [['from-b']] })
    // The oracle: one physical connection despite two subscribers.
    expect(MockSocket.instances.length).toBe(1)
    const sock = MockSocket.instances[0]!
    act(() => {
      sock.fireMessage({ type: 'ping', n: 1 })
    })
    expect(a.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['from-a'] })
    expect(b.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['from-b'] })
  })

  test('releasing one subscriber keeps the socket; releasing the last closes it', () => {
    const a = mountProbe('/ws/shared', { ping: () => [['from-a']] })
    const b = mountProbe('/ws/shared', { ping: () => [['from-b']] })
    expect(MockSocket.instances.length).toBe(1)
    const sock = MockSocket.instances[0]!

    a.unmount()
    expect(sock.closed).toBe(false)
    act(() => {
      sock.fireMessage({ type: 'ping', n: 2 })
    })
    // Unmounted subscriber no longer dispatches; the survivor still does.
    expect(a.invalidateSpy).not.toHaveBeenCalled()
    expect(b.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['from-b'] })

    b.unmount()
    expect(sock.closed).toBe(true)
    // No reconnect after the last release.
    expect(MockSocket.instances.length).toBe(1)
  })

  test('different paths do NOT share a socket', () => {
    mountProbe('/ws/one', { ping: () => [['a']] })
    mountProbe('/ws/two', { ping: () => [['b']] })
    expect(MockSocket.instances.length).toBe(2)
    expect(MockSocket.instances[0]!.url).toContain('/ws/one')
    expect(MockSocket.instances[1]!.url).toContain('/ws/two')
  })

  test('after the last release a fresh mount reconnects (new socket)', () => {
    const a = mountProbe('/ws/shared', { ping: () => [['a']] })
    a.unmount()
    expect(MockSocket.instances[0]!.closed).toBe(true)
    const b = mountProbe('/ws/shared', { ping: () => [['b']] })
    expect(MockSocket.instances.length).toBe(2)
    const sock = MockSocket.instances[1]!
    act(() => {
      sock.fireMessage({ type: 'ping', n: 3 })
    })
    expect(b.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['b'] })
  })

  test('changing to an already-open path reconciles even when both sockets have the same epoch', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const view = (movingPath: string) => (
      <QueryClientProvider client={qc}>
        <Probe path={movingPath} rules={{}} reconcileKeys={[['rotated']]} />
        <Probe path="/ws/b" rules={{}} />
      </QueryClientProvider>
    )
    const utils = render(view('/ws/a'))
    expect(MockSocket.instances).toHaveLength(2)
    act(() => {
      for (const sock of MockSocket.instances) {
        for (const fn of sock.listeners.open ?? []) fn(null)
      }
    })
    invalidateSpy.mockClear()

    // The moving hook carries epoch=1 from /ws/a; the resident /ws/b socket is
    // also epoch=1. Reconciliation must follow the path identity, not only the
    // numeric epoch.
    utils.rerender(view('/ws/b'))
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['rotated'] })
  })
})
