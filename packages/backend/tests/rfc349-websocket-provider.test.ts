// RFC-349 — WebSocket transport consumes one closed realtime contract; the
// realtime query mechanics stay behind that contract's single adapter.
//
// RFC-359 W7 — that adapter is now provider-neutral (`DrizzleRealtimeStore`,
// one implementation for both providers: the four methods are read-only
// selects with no transaction). The two store cases below therefore drive the
// SAME class through the two provider CLIENTS — a real bun:sqlite database and
// a PostgreSQL client fake — which is exactly the boundary this file locks.
// Behavioural equivalence on real engines is in
// `rfc359-w7-realtime-store-conformance.test.ts`.

import type { ServerWebSocket } from 'bun'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import {
  memories,
  nodeRunEvents,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { createRealtimeChannelAccess } from '@/modules/runtime-management/application/realtimeChannelAccess'
import { DrizzleRealtimeStore } from '@/modules/runtime-management/infrastructure/realtimeStore'
import type {
  RealtimeChannelAccess,
  RealtimeCredentialAccess,
  RealtimeIdentityAccess,
} from '@/modules/runtime-management/public/participants'
import type {
  DirectAuthenticatedAuthority,
  DirectRequestAuthority,
  PresenceLease,
} from '@/modules/identity-access/public/participants'
import { createLogger } from '@/util/log'
import { revalidateAllConnections, trackConnection } from '@/ws/connections'
import type { WsConnectionData } from '@/ws/registry'
import { buildWebSocketAdapter } from '@/ws/server'

// RFC-359 AC-6：`sqlRows` / `postgresqlFixture`（回放罐头行的假池）随本波删除——
// 唯一的消费者是那条断言 SQL 文本的 store 用例，它已经合进双引擎、跑真库了。

describe('RFC-349 WebSocket provider boundary', () => {
  test('transport and realtime contracts have no database-provider imports', () => {
    const wsDir = resolve(import.meta.dir, '../src/ws')
    const realtimeDir = resolve(import.meta.dir, '../src/modules/runtime-management')
    const files = [
      ...readdirSync(wsDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => resolve(wsDir, name)),
      resolve(realtimeDir, 'public/participants.ts'),
      resolve(realtimeDir, 'application/realtimeChannelAccess.ts'),
      resolve(realtimeDir, 'application/realtimeCredentialAccess.ts'),
      resolve(realtimeDir, 'application/ports/realtimeStore.ts'),
    ]

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from ['"]@\/db(?:\/|['"])/)
      expect(source, file).not.toMatch(/from ['"]drizzle-orm/)
      expect(source, file).not.toContain('bun:sqlite')
      expect(source, file).not.toContain('PostgresqlDatabaseClient')
    }

    const composition = readFileSync(resolve(realtimeDir, 'composition.ts'), 'utf8')
    expect(composition).toContain('composeRealtimeRuntimeFor')
    expect(composition).toContain('composeRealtimeRuntimeFor')
    expect(composition).not.toMatch(/as\s+(?:unknown\s+as\s+)?DbClient|createInMemoryDb|deasync/)

    const hook = readFileSync(resolve(wsDir, 'revalidationHook.ts'), 'utf8')
    expect(hook).not.toContain('legacySource')
  })

  test('adapter binds required credential, channel, identity and presence ports', async () => {
    const authority = Object.freeze({}) as DirectRequestAuthority
    const actor = buildActor({
      user: {
        id: 'realtime-admin',
        username: 'realtime-admin',
        displayName: 'Realtime Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
      authorityRevision: 7,
    }) as DirectAuthenticatedAuthority
    const channels: RealtimeChannelAccess = Object.freeze({
      canViewTask: async () => false,
      canViewResource: async () => false,
      canViewMemory: async () => false,
      canViewStoredMemory: async () => false,
      replayTaskEvents: async () => [],
      repoImportOwnerUserId: () => null,
    })
    const resolvedTokens: string[] = []
    const credentials = Object.freeze({
      allowLegacyDaemonTestAccess: true,
      async resolveUpgrade(rawToken) {
        resolvedTokens.push(rawToken)
        return {
          actor,
          authority,
          credential: { kind: 'session', hash: 'session-hash', expiresAt: null },
        }
      },
      async reresolve() {
        return { actor, authority }
      },
    } satisfies RealtimeCredentialAccess)
    let presenceOpened = 0
    let presenceReleased = 0
    const identityAccess = Object.freeze({
      directAuthority: {
        fromSession: async () => null,
        fromPat: async () => null,
        fromDaemon: async () => null,
      },
      authorityFence: {
        readAuthorityFence: () => ({ status: 'active', accessRevision: 7 }),
      },
      presenceConnections: {
        open(inputAuthority) {
          expect(inputAuthority).toBe(authority)
          presenceOpened += 1
          return Object.freeze({
            release() {
              presenceReleased += 1
            },
          }) as PresenceLease
        },
      },
      presenceQuery: { snapshot: () => ['realtime-admin'] },
    } satisfies RealtimeIdentityAccess)
    const adapter = buildWebSocketAdapter({
      daemonToken: 'd'.repeat(64),
      realtime: { channels, credentials },
      identityAccess,
    })
    let data: WsConnectionData | undefined
    const upgraded = await adapter.tryUpgrade(
      new Request('http://localhost/ws/presence?token=opaque-session-token'),
      {
        upgrade(_request, options) {
          data = options.data
          return true
        },
      },
    )
    expect(upgraded).toBeTrue()
    expect(resolvedTokens).toEqual(['opaque-session-token'])
    expect(data?.channels).toBe(channels)
    expect(data?.credentials).toBe(credentials)

    const sent: unknown[] = []
    const socket = {
      data: data!,
      send(payload: string) {
        sent.push(JSON.parse(payload))
        return payload.length
      },
    } as unknown as ServerWebSocket<WsConnectionData>
    await adapter.handlers.open(socket)
    expect(presenceOpened).toBe(1)
    expect(sent).toEqual([
      { type: 'hello', channel: 'presence' },
      { type: 'presence.snapshot', online: ['realtime-admin'] },
    ])
    adapter.handlers.close(socket)
    expect(presenceReleased).toBe(1)
  })

  test('revalidation resolves one provider-bound credential once per runtime', async () => {
    const authority = Object.freeze({}) as DirectRequestAuthority
    const actor = buildActor({
      user: {
        id: 'realtime-member',
        username: 'realtime-member',
        displayName: 'Realtime Member',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    }) as DirectAuthenticatedAuthority
    const channels: RealtimeChannelAccess = Object.freeze({
      canViewTask: async () => true,
      canViewResource: async () => true,
      canViewMemory: async () => true,
      canViewStoredMemory: async () => true,
      replayTaskEvents: async () => [],
      repoImportOwnerUserId: () => null,
    })
    let resolutions = 0
    const credentials = Object.freeze({
      allowLegacyDaemonTestAccess: true,
      async resolveUpgrade() {
        throw new Error('not used')
      },
      async reresolve() {
        resolutions += 1
        return { actor, authority }
      },
    } satisfies RealtimeCredentialAccess)
    const identityAccess = {
      directAuthority: {
        fromSession: async () => null,
        fromPat: async () => null,
        fromDaemon: async () => null,
      },
      authorityFence: {
        readAuthorityFence: () => ({ status: 'active' as const, accessRevision: 0 }),
      },
      presenceConnections: { open: () => null },
      presenceQuery: { snapshot: () => [] },
      requestAuthorityRevalidation() {},
    }
    const connection = (): ServerWebSocket<WsConnectionData> =>
      ({
        data: {
          channel: { kind: 'tasks-list' },
          actor,
          authority,
          channels,
          credentials,
          identityAccess,
          credential: { kind: 'session', hash: 'shared-hash', expiresAt: null },
          closing: false,
          revalidating: false,
          upgradeEpoch: 0,
          unsubscribe() {},
          visibilityCache: new Map(),
        },
        send(payload: string) {
          return payload.length
        },
        close() {},
      }) as unknown as ServerWebSocket<WsConnectionData>
    trackConnection(connection())
    trackConnection(connection())

    await expect(
      revalidateAllConnections({ log: createLogger('rfc349-ws-test') }, 'task-members-changed'),
    ).resolves.toEqual({ scanned: 2, closedAuth: 0, closedGate: 0, refreshed: 2 })
    expect(resolutions).toBe(1)
  })

  /**
   * RFC-359 AC-6：这两条此前是一对**手搓的单引擎孪生**——上面一条用真 SQLite 跑
   * `createRealtimeChannelAccess`，下面一条用 `postgresqlFixture` 回放罐头行跑
   * `DrizzleRealtimeStore`，并断言**发出去的 SQL 文本**含 `"agent_workflow"."<表>"`。
   *
   * 但 `DrizzleRealtimeStore` 的形参本来就是 `ProviderNeutralDatabase`——**一份实现**，
   * 两条用例只是喂了两种库。于是合成一条双引擎：同一份真数据、同一组断言，两个引擎各跑一遍。
   *
   * 丢掉的只有那组 SQL 文本断言，这是**净赚**：它们原本用来证明 PG 投影带 schema 限定名，
   * 而在**真 PostgreSQL 上跑通**是对同一件事强得多的证明（限定名写错，查询当场报错）。
   */
  describeEachProvider('RFC-349 realtime store / channel access（双引擎）', (harness) => {
    async function seed(): Promise<void> {
      const db = harness.db
      await db.insert(users).values([
        {
          id: 'realtime-owner',
          username: 'realtime-owner',
          displayName: 'Realtime Owner',
          role: 'user',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'realtime-member',
          username: 'realtime-member',
          displayName: 'Realtime Member',
          role: 'user',
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      await db
        .insert(workflows)
        .values({ id: 'realtime-workflow', name: 'Realtime workflow', definition: '{}' })
      await db.insert(tasks).values({
        id: 'realtime-task',
        name: 'Realtime task',
        workflowId: 'realtime-workflow',
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/worktree',
        baseBranch: 'main',
        branch: 'agent-workflow/realtime-task',
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        ownerUserId: 'realtime-owner',
      })
      await db.insert(taskCollaborators).values({
        taskId: 'realtime-task',
        userId: 'realtime-member',
        role: 'collaborator',
        addedBy: 'realtime-owner',
        addedAt: 1,
      })
      await db.insert(nodeRuns).values({
        id: 'realtime-run',
        taskId: 'realtime-task',
        nodeId: 'node-1',
        status: 'done',
        retryIndex: 0,
        startedAt: 1,
      })
      await db.insert(nodeRunEvents).values([
        { id: 1, nodeRunId: 'realtime-run', ts: 1, kind: 'text', payload: '{"token":"old"}' },
        { id: 2, nodeRunId: 'realtime-run', ts: 2, kind: 'text', payload: '{"token":"new"}' },
      ])
      await db.insert(memories).values({
        id: 'memory-1',
        scopeType: 'repo',
        scopeId: 'repo-1',
        title: 'realtime memory',
        bodyMd: 'body',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: 1,
      })
    }

    test('store answers audience / memory scope / ordered events off real rows', async () => {
      await seed()
      const store = new DrizzleRealtimeStore(harness.db)

      expect(await store.findTaskAudience('realtime-task', 'realtime-member')).toEqual({
        ownerUserId: 'realtime-owner',
        member: true,
      })
      expect(await store.findMemoryScope('memory-1')).toEqual({
        scopeType: 'repo',
        scopeId: 'repo-1',
      })
      expect(await store.listTaskEvents('realtime-task', 1)).toEqual([
        {
          id: 2,
          nodeRunId: 'realtime-run',
          ts: 2,
          kind: 'text',
          payload: '{"token":"new"}',
        },
      ])
    })

    test('channel access preserves task audience and ordered redacted replay', async () => {
      await seed()
      const channels = createRealtimeChannelAccess(new DrizzleRealtimeStore(harness.db), {
        resourceVisibility: { canViewResource: async () => false },
        memoryVisibility: { canViewMemory: async () => false },
        repoImportOwnerUserId: () => null,
        redactTaskEventPayload: (payload) => ({ payload, redacted: true }),
      })
      const actor = buildActor({
        user: {
          id: 'realtime-member',
          username: 'realtime-member',
          displayName: 'Realtime Member',
          role: 'user',
          status: 'active',
        },
        source: 'session',
      })

      await expect(channels.canViewTask(actor, 'realtime-task')).resolves.toBe(true)
      await expect(channels.canViewTask(actor, 'missing-task')).resolves.toBe(false)
      await expect(channels.replayTaskEvents('session', 'realtime-task', 1)).resolves.toEqual([
        {
          id: 2,
          type: 'node.event',
          nodeRunId: 'realtime-run',
          ts: 2,
          kind: 'text',
          payload: { payload: { token: 'new' }, redacted: true },
        },
      ])
    })
  })
})
