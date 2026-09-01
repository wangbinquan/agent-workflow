// RFC-349 — WebSocket transport consumes one closed realtime contract while
// SQLite and PostgreSQL keep their query mechanics inside provider adapters.

import type { ServerWebSocket } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { nodeRunEvents, nodeRuns, taskCollaborators, tasks, users, workflows } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createRealtimeChannelAccess } from '@/modules/runtime-management/application/realtimeChannelAccess'
import { PostgresqlRealtimeStore } from '@/modules/runtime-management/infrastructure/postgresqlRealtimeStore'
import { SqliteRealtimeStore } from '@/modules/runtime-management/infrastructure/sqliteRealtimeStore'
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
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { createLogger } from '@/util/log'
import {
  resetConnectionsForTest,
  revalidateAllConnections,
  trackConnection,
} from '@/ws/connections'
import type { WsConnectionData } from '@/ws/registry'
import { buildWebSocketAdapter } from '@/ws/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function sqlRows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    return sqlRows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_realtime_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  resetConnectionsForTest()
  selectDatabaseSchemaProvider('sqlite')
})

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
    expect(composition).toContain('composeSqliteRealtimeRuntime')
    expect(composition).toContain('composePostgresqlRealtimeRuntime')
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

  test('SQLite channel access preserves task audience and ordered redacted replay', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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
    await db.insert(workflows).values({
      id: 'realtime-workflow',
      name: 'Realtime workflow',
      definition: '{}',
    })
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

    const channels = createRealtimeChannelAccess(new SqliteRealtimeStore(db), {
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
    db.$client.close()
  })

  test('PostgreSQL store uses the same closed audience/resource/memory/event contract', async () => {
    const fake = postgresqlFixture([
      [['realtime-owner']],
      [['realtime-member']],
      [['workflow-1', 'realtime-owner', 'private']],
      [['repo', 'repo-1']],
      [[2, 'realtime-run', 2, 'text', '{"token":"new"}']],
    ])
    const store = new PostgresqlRealtimeStore(fake.db)

    await expect(store.findTaskAudience('realtime-task', 'realtime-member')).resolves.toEqual({
      ownerUserId: 'realtime-owner',
      member: true,
    })
    await expect(store.findResource('workflow', 'workflow-1')).resolves.toEqual({
      id: 'workflow-1',
      ownerUserId: 'realtime-owner',
      visibility: 'private',
    })
    await expect(store.findMemoryScope('memory-1')).resolves.toEqual({
      scopeType: 'repo',
      scopeId: 'repo-1',
    })
    await expect(store.listTaskEvents('realtime-task', 1)).resolves.toEqual([
      {
        id: 2,
        nodeRunId: 'realtime-run',
        ts: 2,
        kind: 'text',
        payload: '{"token":"new"}',
      },
    ])

    expect(fake.executions).toHaveLength(5)
    const sql = fake.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'tasks',
      'task_collaborators',
      'workflows',
      'memories',
      'node_run_events',
      'node_runs',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })
})
