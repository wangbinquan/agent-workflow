// Self-test for the fail-closed Vitest network boundary. This protects both
// the error message and setup.ts wiring so a future test-environment refactor
// cannot silently restore Node's real fetch implementation.

import { describe, expect, test, vi } from 'vitest'
import { takeUnexpectedNetworkRequests, unexpectedNetworkFetch } from './unexpectedNetwork'

describe('unexpected network guard', () => {
  test('setup supplies the shared authority fixture without weakening the network guard', async () => {
    expect(globalThis.fetch).toBe(unexpectedNetworkFetch)

    const me = await globalThis.fetch('http://daemon.test/api/auth/me')
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toMatchObject({
      user: { role: 'admin', status: 'active' },
    })
    expect(takeUnexpectedNetworkRequests()).toEqual([])

    await expect(
      globalThis.fetch('http://daemon.test/api/unmocked', { method: 'POST' }),
    ).rejects.toThrow('Unexpected network request in Vitest: POST http://daemon.test/api/unmocked')
    expect(takeUnexpectedNetworkRequests()).toEqual(['POST http://daemon.test/api/unmocked'])

    // Leave fetch corrupted on purpose. The next test proves setup.ts repairs
    // the boundary before each test, even after a test forgets to restore it.
    globalThis.fetch = vi.fn() as typeof fetch
  })

  test('the global beforeEach restores the guard after another test changes fetch', () => {
    expect(globalThis.fetch).toBe(unexpectedNetworkFetch)
  })
})
