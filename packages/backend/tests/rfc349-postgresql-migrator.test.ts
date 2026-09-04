// RFC-349 T4 — schema admission is durable, idempotent and fail-closed. These
// tests use the exact external-connection protocol without a SQLite fallback.

import { describe, expect, test } from 'bun:test'
import {
  migratePostgresqlSchema,
  PostgresqlMigrationError,
} from '@/platform/persistence/postgresqlMigrator'
import {
  POSTGRESQL_BASELINE_ID,
  type PostgresqlSchemaPlan,
} from '@/platform/persistence/postgresqlSchema'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const plan: PostgresqlSchemaPlan = {
  version: 1,
  baselineId: POSTGRESQL_BASELINE_ID,
  contractDigest: `sha256:${'a'.repeat(64)}`,
  activeTableCount: 1,
  archiveOnlyTableCount: 6,
  statements: [
    { kind: 'bootstrap', logicalId: 'schema', sql: 'CREATE SCHEMA agent_workflow' },
    { kind: 'table', logicalId: 'tasks', sql: 'CREATE TABLE agent_workflow.tasks(id text)' },
    {
      kind: 'metadata',
      logicalId: 'migration-table',
      sql: 'CREATE TABLE agent_workflow_meta.schema_migrations(id text)',
    },
  ],
  digest: `sha256:${'b'.repeat(64)}`,
}

function result(rows: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(rows), {
    async values() {
      return rows.map((row) => Object.values(row))
    },
  })
}

function fixture(input: {
  readonly initial?: 'empty' | 'ready' | 'partial' | 'drift'
  readonly lock?: boolean
  readonly failSql?: string
}) {
  let state = input.initial ?? 'empty'
  const sql: string[] = []
  let releases = 0
  const connection: PostgresqlReservedConnection = {
    unsafe(query) {
      sql.push(query)
      if (query.includes('pg_try_advisory_lock')) return result([{ acquired: input.lock ?? true }])
      if (query.includes('information_schema.tables')) {
        if (state === 'empty') return result([])
        if (state === 'partial') {
          return result([{ table_schema: 'agent_workflow', table_name: 'tasks' }])
        }
        return result([
          { table_schema: 'agent_workflow', table_name: 'tasks' },
          { table_schema: 'agent_workflow_meta', table_name: 'schema_migrations' },
        ])
      }
      if (query.includes('SELECT contract_digest, plan_digest')) {
        return result([
          {
            contract_digest: plan.contractDigest,
            plan_digest: state === 'drift' ? `sha256:${'c'.repeat(64)}` : plan.digest,
          },
        ])
      }
      if (input.failSql !== undefined && query === input.failSql) {
        return Object.assign(Promise.reject(new Error('driver included secret://password')), {
          async values() {
            throw new Error('driver included secret://password')
          },
        })
      }
      if (query === 'COMMIT') state = 'ready'
      return result([])
    },
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: connection.unsafe,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_pg_schema_01',
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
  return {
    runtime,
    sql,
    get releases() {
      return releases
    },
  }
}

describe('RFC-349 PostgreSQL schema migrator', () => {
  test('atomically prepares an empty target and verifies the committed roster', async () => {
    const fake = fixture({})
    expect(await migratePostgresqlSchema({ runtime: fake.runtime, plan, now: () => 123 })).toEqual({
      baselineId: POSTGRESQL_BASELINE_ID,
      contractDigest: plan.contractDigest,
      planDigest: plan.digest,
      applied: true,
      activeTableCount: 1,
    })
    expect(fake.sql).toContain('BEGIN')
    expect(fake.sql).toContain('COMMIT')
    expect(fake.sql).not.toContain('ROLLBACK')
    expect(fake.releases).toBe(1)
  })

  // 2026-09-04 单笔修复：迁移会话不该按在线请求的尺子量。这里的 DDL 只对空库跑
  // （PostgreSQL 只有一份 baseline，`assertSnapshot` 不收中间态），所以 statement_timeout
  // 是保险；真能打中的是 idle 那条——它量的是「服务端等我们」，几百条来回里只要客户端卡一次
  // 就会被掐掉会话、启动失败。`lock_timeout` 量的是别人挡我们，保持配置值不动。
  test('the boot DDL session drops the online statement/idle budgets, and never touches lock_timeout', async () => {
    const fake = fixture({})
    await migratePostgresqlSchema({ runtime: fake.runtime, plan, now: () => 123 })

    const configure = fake.sql[0] ?? ''
    expect(configure).toContain("set_config('statement_timeout', '0', false)")
    expect(configure).toContain("set_config('idle_in_transaction_session_timeout', '0', false)")
    // Before the advisory lock and the DDL transaction, so no statement on this
    // session ever runs under the online budget.
    expect(fake.sql.findIndex((query) => query.includes('pg_try_advisory_lock'))).toBe(1)
    expect(fake.sql.indexOf('BEGIN')).toBeGreaterThan(0)
    expect(fake.sql.some((query) => query.includes('lock_timeout'))).toBeFalse()
  })

  test('a session that cannot be configured releases its connection', async () => {
    const configure =
      "SELECT set_config('statement_timeout', '0', false), " +
      "set_config('idle_in_transaction_session_timeout', '0', false)"
    const fake = fixture({ failSql: configure })

    await expect(migratePostgresqlSchema({ runtime: fake.runtime, plan })).rejects.toMatchObject({
      code: 'postgresql-schema-prepare-failed',
    })
    // Configured inside the guarded block: no lock was taken, no transaction was
    // opened, and the reserved connection still goes back to the pool.
    expect(fake.sql).not.toContain('BEGIN')
    expect(fake.releases).toBe(1)
  })

  test('accepts only an exact already-applied baseline', async () => {
    const fake = fixture({ initial: 'ready' })
    expect(await migratePostgresqlSchema({ runtime: fake.runtime, plan })).toMatchObject({
      applied: false,
    })
    expect(fake.sql).not.toContain('BEGIN')
    expect(fake.releases).toBe(1)
  })

  test('rejects partial, drifted and concurrently owned targets', async () => {
    await expect(
      migratePostgresqlSchema({ runtime: fixture({ initial: 'partial' }).runtime, plan }),
    ).rejects.toMatchObject({ code: 'postgresql-schema-partial' })
    await expect(
      migratePostgresqlSchema({ runtime: fixture({ initial: 'drift' }).runtime, plan }),
    ).rejects.toMatchObject({ code: 'postgresql-schema-drift' })
    await expect(
      migratePostgresqlSchema({ runtime: fixture({ lock: false }).runtime, plan }),
    ).rejects.toMatchObject({ code: 'postgresql-schema-lock-held' })
  })

  test('rolls back a failed statement and never leaks driver/SQL secrets', async () => {
    const secretStatement = "CREATE TABLE agent_workflow.tasks(secret text DEFAULT 'secret-value')"
    const failingPlan: PostgresqlSchemaPlan = {
      ...plan,
      statements: [{ kind: 'table', logicalId: 'tasks', sql: secretStatement }],
    }
    const fake = fixture({ failSql: secretStatement })
    try {
      await migratePostgresqlSchema({ runtime: fake.runtime, plan: failingPlan })
      throw new Error('expected migration failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresqlMigrationError)
      expect(String(error)).not.toContain('secret-value')
      expect(String(error)).not.toContain('password')
    }
    expect(fake.sql).toContain('ROLLBACK')
    expect(fake.releases).toBe(1)
  })
})
