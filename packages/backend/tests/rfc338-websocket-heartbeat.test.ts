import { expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import { WsControlMessageSchema } from '@agent-workflow/shared'
import { buildWebSocketAdapter } from '@/ws/server'
import type { WsConnectionData } from '@/ws/registry'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { composeTestProviderRealtimeRuntime } from './helpers/realtimeRuntime'

// RFC-359 AC-6：这条不需要 server、也不需要应用——它直接调 `adapter.handlers.message`。
// 所以用 `describeEachProvider` 就够，实时运行时按 provider 判别式分派。
describeEachProvider('RFC-338 WebSocket responsiveness control frame', (harness) => {
  test('answers a bounded ping without DB/domain work and ignores every other inbound frame', () => {
    const db = harness.db
    const identityAccess = createIdentityAccessRuntime({ db })
    const adapter = buildWebSocketAdapter({
      daemonToken: 'd'.repeat(64),
      realtime: composeTestProviderRealtimeRuntime({
        binding: harness.applicationBinding,
        neutralDb: db,
        identityAccess,
      }),
      identityAccess,
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
