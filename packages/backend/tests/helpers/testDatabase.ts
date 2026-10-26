import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
// RFC-395 II-b M-a: install the target head, never replay the epoch-1 chain.
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'

import { persistenceHead } from '@/bootstrap/persistenceHead'
import { createSqliteBaseline, installSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDb, bindSqliteClient, registerLegacyDaemonTestFixture } from '@/db/client'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  createPostgresqlDatabaseClient,
  resetPostgresqlGenerationWriteCache,
  type PostgresqlDatabaseClient,
} from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { installHistoryHead } from '@/platform/persistence/schema/history/apply'
import {
  postgresqlHistoryConnection,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'

import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import { Database } from 'bun:sqlite'
import { guardSqliteGenerationWrites } from '@/platform/persistence/sqliteGenerationFence'
import type {
  CreateTestDb,
  CreateTestDbOptions,
  TestDatabase,
  TestDatabaseMetaTables,
} from './testDatabaseTypes'

type BaselineOptions = Pick<CreateTestDbOptions, 'bootstrap' | 'now'>
function baseline(head: HistoryVersion): TestDatabase['baseline'] {
  return Object.freeze({
    schemaEpoch: 2,
    head,
    seeds: 'install-only',
    metaTables: Object.freeze(
      EPOCH2_META_TABLES.map((table) => table.name),
    ) as unknown as TestDatabaseMetaTables,
    binding: 'epoch-2',
  })
}

async function initializeFixture(
  connection: HistoryConnection,
  options: BaselineOptions,
): Promise<void> {
  if (options.bootstrap !== 'required') {
    const table =
      connection.provider === 'sqlite'
        ? 'auth_login_policy'
        : '"agent_workflow"."auth_login_policy"'
    await connection.execute(
      `UPDATE ${table} SET bootstrap_completed_at = coalesce(bootstrap_completed_at, 0) WHERE id = 'global'`,
    )
  }
}

async function createSqliteTestDatabase(
  options: Extract<CreateTestDbOptions, { provider: 'sqlite' }>,
): Promise<TestDatabase> {
  const head = persistenceHead()
  const now = options.now ?? Date.now()
  const generationId = `dbg_test_${randomUUID()}`
  const filename = options.filename
  const template = createSqliteBaseline({ ...options, now, generationId })
  let db: ReturnType<typeof openDb>
  try {
    if (filename) {
      mkdirSync(dirname(filename), { recursive: true })
      writeFileSync(filename, template.serialize())
      db = openDb({ path: filename, skipMigrations: true })
    } else {
      db = bindSqliteClient(template)
    }
  } catch (error) {
    if (!filename) template.close()
    throw error
  } finally {
    if (filename) template.close()
  }
  const raw = db.$client
  const resetFence = guardSqliteGenerationWrites(raw, generationId)
  // Installation owns an unfenced native connection surface; business tests use db.
  const installation = new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (['query', 'prepare', 'exec'].includes(String(property)))
        return (Reflect.get(Database.prototype, property) as (...args: unknown[]) => unknown).bind(
          target,
        )
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  let closed = false
  if (options.bootstrap !== 'required') registerLegacyDaemonTestFixture(db)
  const session = databaseSessionFor(db)
  return {
    db,
    session,
    capabilities: session.engine,
    provider: 'sqlite',
    baseline: baseline(head),
    async reset() {
      if (closed) throw new Error('Test database is closed')
      const objects = installation
        .query<
          { type: string; name: string },
          []
        >("SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'trigger', 'table') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'view' THEN 0 WHEN 'trigger' THEN 1 ELSE 2 END")
        .all()
      installation.exec('PRAGMA foreign_keys = OFF')
      try {
        for (const object of objects)
          installation.exec(
            `DROP ${object.type.toUpperCase()} "${object.name.replaceAll('"', '""')}"`,
          )
      } finally {
        installation.exec('PRAGMA foreign_keys = ON')
      }
      installSqliteBaseline(installation, { ...options, now, generationId })
      resetFence()
    },
    async close() {
      if (closed) return
      closed = true
      raw.close()
    },
  }
}

/** eachProvider owns its database lifecycle and injects the same recorded runtime used by the app. */
export async function createPostgresqlTestDatabase(
  runtime: PostgresqlDatabaseRuntime,
  options: BaselineOptions = {},
): Promise<TestDatabase & { readonly db: PostgresqlDatabaseClient }> {
  const head = persistenceHead()
  const now = options.now ?? Date.now()
  const pool = runtime.providerPool()
  let closed = false
  const install = async () => {
    resetPostgresqlGenerationWriteCache(runtime)
    await installHistoryHead(postgresqlHistorySession(pool), {
      version: head,
      generationId: runtime.generationId,
      installPath: 'test-baseline',
      metaTables: EPOCH2_META_TABLES,
      now: () => now,
    })
    await initializeFixture(postgresqlHistoryConnection(pool), options)
  }
  await install()
  const db = createPostgresqlDatabaseClient(runtime)
  if (options.bootstrap !== 'required') registerLegacyDaemonTestFixture(db)
  const session = databaseSessionFor(db)
  return {
    db,
    session,
    capabilities: session.engine,
    provider: 'postgresql',
    baseline: baseline(head),
    async reset() {
      if (closed) throw new Error('Test database is closed')
      await pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
      await pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
      await install()
    },
    async close() {
      if (closed) return
      closed = true
      await runtime.close()
    },
  }
}

export const createTestDb: CreateTestDb = async (options = { provider: 'sqlite' }) => {
  if (options.provider === 'sqlite') return await createSqliteTestDatabase(options)
  const sourceUrl = process.env[options.urlEnv]
  if (!sourceUrl) throw new Error(`PostgreSQL test database URL is missing: ${options.urlEnv}`)
  const name = `aw_target_test_${randomUUID().replaceAll('-', '')}`
  const admin = new SQL(sourceUrl, { max: 1, idleTimeout: 0 })
  let runtime: PostgresqlDatabaseRuntime | undefined
  let created = false
  const cleanup = async () => {
    try {
      await runtime?.close()
    } finally {
      try {
        if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
      } finally {
        await admin.close()
      }
    }
  }
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    created = true
    const url = new URL(sourceUrl)
    url.pathname = `/${name}`
    runtime = createPostgresqlDatabaseRuntime({
      generationId: `dbg_test_${randomUUID()}`,
      config: {
        provider: 'postgresql',
        urlEnv: options.urlEnv,
        poolMax: 16,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleTimeoutMs: 30_000,
      },
      env: { [options.urlEnv]: url.toString() },
    })
    const fixture = await createPostgresqlTestDatabase(runtime, options)
    let closing: Promise<void> | undefined
    return {
      ...fixture,
      close: () =>
        (closing ??= (async () => {
          try {
            await fixture.close()
          } finally {
            await cleanup()
          }
        })()),
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
