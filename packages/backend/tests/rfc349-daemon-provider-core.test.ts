// RFC-349 -- one provider composition must feed every daemon-facing closed
// contract.  In particular, the PostgreSQL branch cannot touch SQLite/openDb,
// and composing or shutting down identity presence must not close the outer
// provider runtime.

import type { DatabaseConfig } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlIdentityAccessCrossContextBindings } from '@/modules/identity-access/composition/providerOperations'
import type { RealtimeCompositionPolicy } from '@/modules/runtime-management/public/participants'
import type { LocalSystemOperationContext } from '@/modules/system-operations/public/types'
import {
  composePostgresqlDaemonProviderCore,
  composeSqliteDaemonProviderCore,
  type DaemonProviderCore,
} from '@/server'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

function policy(): RealtimeCompositionPolicy {
  return Object.freeze({
    resourceVisibility: { canViewResource: async () => false },
    memoryVisibility: { canViewMemory: async () => false },
    repoImportOwnerUserId: () => null,
    redactTaskEventPayload: (payload: unknown) => payload,
  })
}

const identityEvents = Object.freeze({
  authorityRevisionChanged() {},
})
const presenceProjection = Object.freeze({
  publish() {},
})

function expectClosedCore(core: DaemonProviderCore, provider: DaemonProviderCore['provider']) {
  expect(Object.isFrozen(core)).toBeTrue()
  expect(core.provider).toBe(provider)
  expect(core.authRuntime.provider).toBe(provider)
  expect(core.identityAccess).toBe(core.identityAccess)
  expect(core.realtime).toBe(core.realtime)
  expect(core.repositoryWorkspaceStore).toBe(core.repositoryWorkspaceStore)
  expect(core.repositoryWorkspaceOperations).toBe(core.repositoryWorkspaceOperations)
  expect(core.repositoryTransportCredentialRepository).toBe(
    core.repositoryTransportCredentialRepository,
  )
  expect(String(core.systemOperations.operations.requestBackup.id)).toBe(
    'system-operations.request-backup.v1',
  )
}

function rows(
  objects: readonly Record<string, unknown>[] = [],
  values: readonly (readonly unknown[])[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const statements: string[] = []
  let closes = 0
  let reserves = 0
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    if (/count\(\*\)/i.test(sql)) return rows([], [[0]])
    return rows()
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      reserves += 1
      return connection
    },
    unsafe: execute,
    async close() {
      closes += 1
    },
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_daemon_core_pg',
    providerPool: () => pool,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    async close() {
      closes += 1
    },
  }
  return {
    runtime,
    db: createPostgresqlDatabaseClient(runtime),
    statements,
    get closes() {
      return closes
    },
    get reserves() {
      return reserves
    },
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 daemon provider core', () => {
  test('SQLite composes the same closed surface without owning client shutdown', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-daemon-core-sqlite-'))
    roots.push(appHome)
    const db = createInMemoryDb(MIGRATIONS)
    const core = composeSqliteDaemonProviderCore({
      db,
      appHome,
      dbPath: join(appHome, 'db.sqlite'),
      lockPath: join(appHome, '.daemon.lock'),
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 1)),
      realtimePolicy: policy(),
      onCredentialRevoked() {},
      identityEvents,
      presenceProjection,
    })

    expectClosedCore(core, 'sqlite')
    expect(core.repositoryWorkspaceStore.runtimeIdentity).toBe(db)
    await expect(core.healthDatabase.countRunningTasks()).resolves.toBe(0)

    core.identityAccess.shutdown()
    await expect(core.healthDatabase.countRunningTasks()).resolves.toBe(0)
    db.$client.close()
  })

  test('PostgreSQL composes without SQL/openDb and delegates lifetime to the outer session', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-daemon-core-postgresql-'))
    roots.push(appHome)
    const fake = postgresqlFixture()
    const databaseConfig = {
      provider: 'postgresql',
      urlEnv: 'RFC349_DAEMON_CORE_DATABASE_URL',
      poolMax: 8,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    } satisfies Extract<DatabaseConfig, { provider: 'postgresql' }>
    const core = composePostgresqlDaemonProviderCore({
      db: fake.db,
      runtime: fake.runtime,
      databaseConfig,
      identityCrossContext: createPostgresqlIdentityAccessCrossContextBindings(),
      appHome,
      lockPath: join(appHome, '.daemon.lock'),
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 2)),
      realtimePolicy: policy(),
      onCredentialRevoked() {},
      identityEvents,
      presenceProjection,
    })

    expectClosedCore(core, 'postgresql')
    const applyPendingRestore: () => Promise<boolean> = core.systemOperations.applyPendingRestore
    expect(typeof applyPendingRestore).toBe('function')
    expect(core.repositoryWorkspaceStore.runtimeIdentity).toBe(fake.db)
    expect(fake.statements).toEqual([])
    expect(fake.reserves).toBe(0)
    expect(fake.closes).toBe(0)

    core.identityAccess.shutdown()
    expect(fake.closes).toBe(0)
    await expect(core.healthDatabase.countRunningTasks()).resolves.toBe(0)
    expect(fake.statements.at(-1)).toContain('tasks')
    expect(fake.closes).toBe(0)

    const beforeBackup = fake.statements.length
    await expect(
      core.systemOperations.application.commands.requestBackup.execute(
        {} as LocalSystemOperationContext,
        { includeWorktrees: false },
      ),
    ).rejects.toThrow()
    // Source Control preparation ran against the same PostgreSQL client before
    // the real logical-backup implementation rejected the absent generation fixture.
    expect(fake.statements.length).toBeGreaterThan(beforeBackup)
    expect(fake.closes).toBe(0)
  })

  test('the PostgreSQL branch has no SQLite fallback or hidden client opener', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8')
    const pgStart = source.indexOf('export function composePostgresqlDaemonProviderCore')
    const pg = source.slice(pgStart, source.indexOf('\nexport interface AppDeps', pgStart))

    expect(source).not.toMatch(/\bopenDb\b|createInMemoryDb|deasync/)
    expect(source).not.toMatch(/as\s+(?:unknown\s+as\s+)?DbClient/)
    expect(pg).toContain('createPostgresqlAuthRuntime')
    expect(pg).toContain('createPostgresqlIdentityAccessRuntime')
    expect(pg).toContain('composePostgresqlRealtimeRuntime')
    expect(pg).toContain('composePostgresqlSystemOperations')
    expect(pg).toContain(
      'repositoryBackupPreparation: repositoryWorkspaceOperations.backupPreparation',
    )
    expect(pg).not.toMatch(/(?:create|compose)Sqlite/)
    expect(pg).not.toContain('runtime.close')
  })

  test('one generic provider boundary mounts the same closed application topology', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8')
    const inputStart = source.indexOf('export interface ProviderAppCompositionInput<')
    const composeStart = source.indexOf('export function composeProviderAppDeps<', inputStart)
    const namedEntries = source.indexOf('/** Named production entry points', composeStart)

    expect(inputStart).toBeGreaterThan(-1)
    expect(composeStart).toBeGreaterThan(inputStart)
    expect(namedEntries).toBeGreaterThan(composeStart)

    const boundary = source.slice(inputStart, namedEntries)
    const compose = source.slice(composeStart, namedEntries)

    expect(boundary).toContain('readonly core: SelectedDaemonProviderCore<TProvider>')
    expect(boundary).toContain(
      "export type SqliteAppCompositionInput = ProviderAppCompositionInput<'sqlite'>",
    )
    expect(boundary).toContain(
      "export type PostgresqlAppCompositionInput = ProviderAppCompositionInput<'postgresql'>",
    )
    expect(compose).toContain('input: ProviderAppCompositionInput<TProvider>')
    expect(compose).toContain('return freezeComposedAppDeps({')
    expect(compose).not.toMatch(/\bDbClient\b|PostgresqlDatabaseClient|\bopenDb\b/)
    expect(compose).not.toMatch(/(?:create|compose)(?:Sqlite|Postgresql)/)
    expect(compose).not.toContain('createApp(')
  })
})
