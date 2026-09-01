import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import { buildActor } from '../src/auth/actor'
import type { DirectRequestAuthority } from '../src/modules/identity-access/public/participants'
import type { RealtimeRuntime } from '../src/modules/runtime-management/public/participants'
import { liveConnectionCount, resetConnectionsForTest } from '../src/ws/connections'
import { buildWebSocketAdapter, WS_CLOSE_PROVIDER_TRANSITION } from '../src/ws/server'
import type { WsConnectionData } from '../src/ws/registry'
import { stubIdentityAccessWsBinding } from './helpers/identityAccessWs'
import { STUB_REALTIME_CHANNELS } from './helpers/realtimeRuntime'

const ACTOR = buildActor({
  user: {
    id: 'ws-admission-user',
    username: 'ws-admission-user',
    displayName: 'WS Admission User',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

const AUTHORITY = Object.freeze({}) as DirectRequestAuthority

const REALTIME: RealtimeRuntime = Object.freeze({
  channels: STUB_REALTIME_CHANNELS,
  credentials: Object.freeze({
    allowLegacyDaemonTestAccess: true,
    async resolveUpgrade() {
      return {
        actor: ACTOR,
        authority: AUTHORITY,
        credential: Object.freeze({ kind: 'session' as const, hash: 'hash', expiresAt: null }),
      }
    },
    async reresolve() {
      return null
    },
  }),
})

function createAdapter() {
  return buildWebSocketAdapter({
    daemonToken: 'daemon-token',
    realtime: REALTIME,
    identityAccess: stubIdentityAccessWsBinding(),
  })
}

async function acceptUpgrade(adapter: ReturnType<typeof createAdapter>) {
  let data: WsConnectionData | null = null
  const result = await adapter.tryUpgrade(
    new Request('http://localhost/ws/tasks?token=session-token'),
    {
      upgrade(_request, options) {
        data = options.data
        return true
      },
    },
  )
  expect(result).toBe(true)
  if (data === null) throw new Error('upgrade did not capture websocket data')

  const closes: Array<{ code: number; reason: string }> = []
  const socket = {
    data,
    send(payload: string) {
      return payload.length
    },
    close(code: number, reason: string) {
      closes.push({ code, reason })
    },
  } as unknown as ServerWebSocket<WsConnectionData>
  return { socket, closes }
}

afterEach(() => resetConnectionsForTest())

describe('RFC-349 provider-session WebSocket admission', () => {
  test('closed admission rejects new upgrades without invoking Bun upgrade', async () => {
    const adapter = createAdapter()
    await adapter.admission.close()
    let upgradeCalled = false

    const response = await adapter.tryUpgrade(
      new Request('http://localhost/ws/tasks?token=session-token'),
      {
        upgrade() {
          upgradeCalled = true
          return true
        },
      },
    )

    expect(upgradeCalled).toBe(false)
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(503)
    expect(await (response as Response).json()).toEqual({
      ok: false,
      code: 'ws-admission-closed',
      message: 'websocket admission is closed for a provider transition',
    })
  })

  test('close drains tracked sockets before resolving', async () => {
    const adapter = createAdapter()
    const { socket, closes } = await acceptUpgrade(adapter)
    await adapter.handlers.open(socket)
    expect(liveConnectionCount()).toBe(1)

    await adapter.admission.close()

    expect(liveConnectionCount()).toBe(0)
    expect(closes).toEqual([{ code: WS_CLOSE_PROVIDER_TRANSITION, reason: 'provider-transition' }])
  })

  test('close waits for an accepted upgrade that has not reached open', async () => {
    const adapter = createAdapter()
    const { socket, closes } = await acceptUpgrade(adapter)
    let drained = false
    const drain = adapter.admission.close().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await adapter.handlers.open(socket)
    await drain

    expect(drained).toBe(true)
    expect(liveConnectionCount()).toBe(0)
    expect(closes).toEqual([{ code: WS_CLOSE_PROVIDER_TRANSITION, reason: 'provider-transition' }])
  })

  test('reopening is allowed only after the prior live set drained', async () => {
    const adapter = createAdapter()
    await adapter.admission.close()
    adapter.admission.open()

    const { socket } = await acceptUpgrade(adapter)
    await adapter.handlers.open(socket)
    expect(liveConnectionCount()).toBe(1)
    adapter.handlers.close(socket)
    expect(liveConnectionCount()).toBe(0)
  })
})
