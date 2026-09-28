// RFC-370: one deployment-selected identity adapter must cover the complete
// WebSocket lifetime, including upgrade/open revalidation and synchronous expiry.
import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { admitDurableWorkOwner } from '@/modules/identity-access/composition/authentication'
import type { WebSocketAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { buildWebSocketAdapter } from '@/ws/server'
import {
  revalidateAllConnections,
  resetConnectionsForTest,
  WS_CLOSE_AUTH_REVOKED,
} from '@/ws/connections'
import type { WsConnectionData } from '@/ws/registry'
import { triggerRevalidationAndWait } from '@/ws/revalidationHook'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import { composeTestProviderRealtimeRuntime } from './helpers/realtimeRuntime'

afterEach(resetConnectionsForTest)

describeEachProvider('RFC-370 selected WebSocket identity adapter', (harness) => {
  test('uses alternate credentials for upgrade, open, coalesced refresh and frame expiry', async () => {
    await harness.db.insert(users).values({
      id: 'ws-adapter-user',
      username: 'ws-adapter-user',
      displayName: 'WS adapter user',
      role: 'admin',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    })
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    const identity = await admitDurableWorkOwner(identityAccess, 'ws-adapter-user')
    if (identity === null) throw new Error('fixture identity missing')
    const reference = Object.freeze({ subject: 'fixture-subject', revision: 'fixture-1' })
    let expiresAt: number | null = null
    let resolutions = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const credentials: WebSocketAuthenticationParticipant = {
      async resolveUpgrade(request) {
        expect(new URL(request.url).searchParams.has('token')).toBe(false)
        if (request.header('X-Fixture-Identity') !== 'fixture-subject') {
          return { actor: null, authority: null, credential: reference }
        }
        await barrier
        return { ...identity, credential: reference }
      },
      async reresolve(credential) {
        expect(credential).toBe(reference)
        resolutions += 1
        return identity
      },
      revalidationKey(credential) {
        expect(credential).toBe(reference)
        return 'fixture-subject:fixture-1'
      },
      expiresAt(credential) {
        expect(credential).toBe(reference)
        return expiresAt
      },
    }
    const realtime = composeTestProviderRealtimeRuntime({
      binding: harness.applicationBinding,
      neutralDb: harness.db,
      identityAccess,
    })
    const adapter = buildWebSocketAdapter({
      realtime: { ...realtime, credentials },
      identityAccess,
    })
    const sockets: ServerWebSocket<WsConnectionData>[] = []
    const log = createLogger('rfc370-ws-fixture')
    const request = () =>
      new Request('http://localhost/ws/presence', {
        headers: { 'X-Fixture-Identity': 'fixture-subject' },
      })
    async function upgrade() {
      let data: WsConnectionData | undefined
      expect(
        await adapter.tryUpgrade(request(), {
          upgrade(_request, options) {
            data = options.data
            return true
          },
        }),
      ).toBe(true)
      if (data === undefined) throw new Error('upgrade did not receive connection data')
      const sent: string[] = []
      const closed: number[] = []
      const socket = {
        data,
        send(payload: string) {
          sent.push(payload)
          return payload.length
        },
        close(code: number) {
          closed.push(code)
        },
      } as unknown as ServerWebSocket<WsConnectionData>
      sockets.push(socket)
      return { socket, sent, closed }
    }
    try {
      let settled = false
      const firstPending = upgrade().then((connection) => {
        settled = true
        return connection
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      release()
      const first = await firstPending
      // Advance the existing epoch between upgrade and open. Open must use
      // this same adapter, before subscribing or registering presence.
      await triggerRevalidationAndWait('task-members-changed')
      await adapter.handlers.open(first.socket)
      expect(resolutions).toBe(1)
      expect(first.sent.some((frame) => JSON.parse(frame).type === 'presence.snapshot')).toBe(true)
      const second = await upgrade()
      await adapter.handlers.open(second.socket)
      expect(await revalidateAllConnections({ log }, 'task-members-changed')).toMatchObject({
        scanned: 2,
        refreshed: 2,
        closedAuth: 0,
      })
      expect(resolutions).toBe(2)

      const beforeExpiry = first.sent.length
      expiresAt = Date.now() - 1
      presenceBroadcaster.broadcast(PRESENCE_CHANNEL, {
        type: 'presence.changed',
        changes: [{ userId: 'ws-adapter-user', online: true }],
      })
      expect(first.sent).toHaveLength(beforeExpiry)
      expect(first.closed).toEqual([WS_CLOSE_AUTH_REVOKED])
      expect(second.closed).toEqual([WS_CLOSE_AUTH_REVOKED])
      expect(resolutions).toBe(2)
      const rejected = await adapter.tryUpgrade(new Request('http://localhost/ws/presence'), {
        upgrade() {
          throw new Error('missing fixture identity must not upgrade')
        },
      })
      expect(rejected).toBeInstanceOf(Response)
      expect((rejected as Response).status).toBe(401)
    } finally {
      release()
      for (const socket of sockets) adapter.handlers.close(socket)
      identityAccess.shutdown()
    }
  })
})
