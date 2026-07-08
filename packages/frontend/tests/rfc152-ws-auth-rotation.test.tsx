// RFC-152 impl-gate high regression — shared-socket pool must rotate on
// auth-store changes.
//
// Why this file exists: the pool is keyed by path ONLY. Before the fix a
// socket created under token/baseUrl A stayed live across setToken /
// setBaseUrl, so a subscriber mounted after a re-login or a remote-daemon
// switch rode the stale connection (the pre-share hook gave every new mount
// a fresh socket, so this was a sharing-introduced regression). The manager
// now subscribes to the auth store and force-rotates every pooled socket.
// Locks:
//   1. setToken with a live subscriber → physical socket swaps to the new
//      token URL (old one client-closed), listener registration intact.
//   2. setBaseUrl likewise re-points the socket at the new daemon origin.
//   3. A subscriber mounted AFTER the rotation shares the fresh socket —
//      no third construction (refcount sharing survives rotation).
//   4. The superseded socket's close event must NOT reschedule a reconnect
//      (a ghost second socket would otherwise appear after the backoff).
//   5. (re-gate) A CONNECTING socket superseded mid-handshake gets a
//      DEFERRED close (closeSocket waits for its open) — frames it flushes
//      in that window carry the OLD token/daemon view and must be ignored.
//   6. (re-gate) clearToken tears the socket down and waits for a token —
//      no reconnect churn until the next login rotates the pool.
//   7. (re-gate) double rotation: only the latest socket dispatches; both
//      predecessors' late frames are dropped.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'
import { useWebSocket } from '../src/hooks/useWebSocket'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  clientClosed = false
  readyState = 1 // OPEN; tests set 0 (CONNECTING) to exercise deferred close
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
    this.clientClosed = true
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

function Sub({ path, onMessage = () => {} }: { path: string; onMessage?: (m: unknown) => void }) {
  useWebSocket({ path, onMessage })
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
})

describe('RFC-152 — shared WS pool rotates on auth changes', () => {
  test('setToken swaps the physical socket; listeners keep receiving', () => {
    const seen: unknown[] = []
    render(<Sub path="/ws/tasks/t1" onMessage={(m) => seen.push(m)} />)
    expect(MockSocket.instances).toHaveLength(1)
    expect(MockSocket.instances[0]!.url).toContain('token=tok')

    act(() => setToken('tok2'))
    expect(MockSocket.instances).toHaveLength(2)
    expect(MockSocket.instances[0]!.clientClosed).toBe(true)
    expect(MockSocket.instances[1]!.url).toContain('token=tok2')

    // Listener registration survived the rotation — frames on the NEW socket
    // still reach the subscriber.
    act(() => MockSocket.instances[1]!.fireMessage({ type: 'task.updated' }))
    expect(seen).toEqual([{ type: 'task.updated' }])
  })

  test('setBaseUrl re-points the socket at the new daemon origin', () => {
    render(<Sub path="/ws/workflows" />)
    expect(MockSocket.instances[0]!.url.startsWith('ws://daemon.test/')).toBe(true)

    act(() => setBaseUrl('http://other.test'))
    expect(MockSocket.instances).toHaveLength(2)
    expect(MockSocket.instances[1]!.url.startsWith('ws://other.test/')).toBe(true)
    expect(MockSocket.instances[1]!.url).toContain('token=tok')
  })

  test('subscriber mounted AFTER rotation shares the fresh socket (no stale ride, no extra socket)', () => {
    render(<Sub path="/ws/tasks/t1" />)
    act(() => setToken('tok2'))
    expect(MockSocket.instances).toHaveLength(2)

    // The Codex-gate scenario: a late subscriber must neither open a third
    // socket nor ride a token-A connection.
    render(<Sub path="/ws/tasks/t1" />)
    expect(MockSocket.instances).toHaveLength(2)
    expect(MockSocket.instances[1]!.url).toContain('token=tok2')
  })

  test('superseded socket close does not reschedule — no ghost socket after backoff window', () => {
    vi.useFakeTimers()
    try {
      render(<Sub path="/ws/tasks/t1" />)
      act(() => setToken('tok2'))
      expect(MockSocket.instances).toHaveLength(2)

      // If the old socket's close handler had scheduled a reconnect, it
      // would fire within the base backoff (500ms) and construct a third
      // socket alongside the rotated one.
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(MockSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('CONNECTING socket superseded mid-handshake: its late frames are ignored (stale-frame window)', () => {
    const seen: unknown[] = []
    render(<Sub path="/ws/tasks/t1" onMessage={(m) => seen.push(m)} />)
    const old = MockSocket.instances[0]!
    old.readyState = 0 // CONNECTING — closeSocket defers the close until open

    act(() => setToken('tok2'))
    expect(MockSocket.instances).toHaveLength(2)
    expect(old.clientClosed).toBe(false) // deferred — handshake still pending

    // The old socket flushes a queued frame carrying the OLD token/daemon
    // view — the current-socket guard must drop it.
    act(() => old.fireMessage({ type: 'task.updated', stale: true }))
    expect(seen).toEqual([])

    // Handshake completes → the deferred close finally fires.
    act(() => old.fireOpen())
    expect(old.clientClosed).toBe(true)

    // Frames on the CURRENT socket still flow.
    act(() => MockSocket.instances[1]!.fireMessage({ type: 'task.updated' }))
    expect(seen).toEqual([{ type: 'task.updated' }])
  })

  test('clearToken tears the socket down and waits; the next login rotates the pool', () => {
    vi.useFakeTimers()
    try {
      render(<Sub path="/ws/tasks/t1" />)
      expect(MockSocket.instances).toHaveLength(1)

      act(() => clearToken())
      expect(MockSocket.instances[0]!.clientClosed).toBe(true)
      expect(MockSocket.instances).toHaveLength(1)

      // Token-less: the 2s retry keeps polling but must not construct.
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(MockSocket.instances).toHaveLength(1)

      act(() => setToken('tok2'))
      expect(MockSocket.instances).toHaveLength(2)
      expect(MockSocket.instances[1]!.url).toContain('token=tok2')
    } finally {
      vi.useRealTimers()
    }
  })

  test('double rotation: only the latest socket dispatches; predecessors are dropped', () => {
    const seen: unknown[] = []
    render(<Sub path="/ws/tasks/t1" onMessage={(m) => seen.push(m)} />)
    act(() => setToken('tok2'))
    act(() => setToken('tok3'))
    expect(MockSocket.instances).toHaveLength(3)

    act(() => MockSocket.instances[0]!.fireMessage({ n: 1 }))
    act(() => MockSocket.instances[1]!.fireMessage({ n: 2 }))
    expect(seen).toEqual([])

    act(() => MockSocket.instances[2]!.fireMessage({ n: 3 }))
    expect(seen).toEqual([{ n: 3 }])
  })
})
