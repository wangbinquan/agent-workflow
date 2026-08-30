import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import { WsControlMessageSchema } from '@agent-workflow/shared'
import { createInMemoryDb } from '@/db/client'
import { buildWebSocketAdapter } from '@/ws/server'
import type { WsConnectionData } from '@/ws/registry'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-338 WebSocket responsiveness control frame', () => {
  test('answers a bounded ping without DB/domain work and ignores every other inbound frame', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const adapter = buildWebSocketAdapter({
      daemonToken: 'd'.repeat(64),
      db,
      identityAccess: createIdentityAccessRuntime({ db }),
    })
    const sent: string[] = []
    const ws = {
      send: (value: string) => {
        sent.push(value)
        return value.length
      },
    } as unknown as ServerWebSocket<WsConnectionData>

    adapter.handlers.message(ws, JSON.stringify({ type: 'ping', nonce: 17 }))
    expect(sent.map((value) => WsControlMessageSchema.parse(JSON.parse(value)))).toEqual([
      { type: 'pong', nonce: 17 },
    ])

    adapter.handlers.message(ws, '{bad-json')
    adapter.handlers.message(ws, JSON.stringify({ type: 'ping', nonce: 18, extra: true }))
    adapter.handlers.message(ws, 'x'.repeat(257))
    expect(sent).toHaveLength(1)
  })
})
