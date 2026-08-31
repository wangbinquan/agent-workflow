// RFC-349 T3 — target preflight is deterministic, secret-free and leaves its
// capability probe rolled back on both success and failure.

import { describe, expect, test } from 'bun:test'
import {
  PostgresqlPreflightError,
  preflightPostgresqlTarget,
} from '@/platform/persistence/postgresqlPreflight'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'

function rows(value: readonly Record<string, unknown>[]) {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

function fakeRuntime(input: {
  readonly environment?: Record<string, unknown>
  readonly tables?: readonly Record<string, unknown>[]
  readonly operations?: readonly Record<string, unknown>[]
  readonly lockAcquired?: boolean
  readonly failWhenSqlIncludes?: string
}) {
  const queries: Array<{ sql: string; parameters: readonly unknown[] | undefined }> = []
  const connection: PostgresqlReservedConnection = {
    unsafe(sql, parameters) {
      queries.push({ sql, parameters })
      if (input.failWhenSqlIncludes !== undefined && sql.includes(input.failWhenSqlIncludes)) {
        throw new Error('driver failure containing postgresql://user:secret@target/app')
      }
      if (sql.includes("current_setting('server_version_num')")) {
        return rows([
          input.environment ?? {
            server_version_num: '170004',
            server_encoding: 'UTF8',
            timezone: 'UTC',
            database_bytes: '8192',
            has_c_collation: true,
          },
        ])
      }
      if (sql.includes('information_schema.tables')) return rows(input.tables ?? [])
      if (sql.includes('logical_copy_operations')) return rows(input.operations ?? [])
      if (sql.includes('pg_try_advisory_lock')) {
        return rows([{ acquired: input.lockAcquired ?? true }])
      }
      return rows([])
    },
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe(sql, parameters) {
      return connection.unsafe(sql, parameters)
    },
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_preflight_target_01',
    async health() {
      return {
        provider: 'postgresql',
        generationId: 'dbg_preflight_target_01',
        ok: true,
        latencyMs: 1,
        databaseFingerprint: 'pg:preflight-target',
        serverVersion: 'PostgreSQL 17.4',
        errorCategory: null,
      }
    },
    async readiness() {
      return {
        provider: 'postgresql',
        generationId: 'dbg_preflight_target_01',
        ok: true as const,
        latencyMs: 1,
        databaseFingerprint: 'pg:preflight-target',
        serverVersion: 'PostgreSQL 17.4',
        errorCategory: null,
      }
    },
    async acquireMigrationAdvisoryLock() {
      return null
    },
    providerPool() {
      return pool
    },
    async close() {},
  }
  return { runtime, queries }
}

describe('RFC-349 PostgreSQL target preflight', () => {
  test('accepts a supported empty target and always rolls back its capability probe', async () => {
    const fake = fakeRuntime({})
    await expect(
      preflightPostgresqlTarget({ runtime: fake.runtime, operationId: 'dbm_preflight_empty_01' }),
    ).resolves.toMatchObject({
      ok: true,
      databaseFingerprint: 'pg:preflight-target',
      serverMajor: 17,
      databaseBytes: 8192,
      targetState: 'empty',
      applicationTableCount: 0,
      metadataTableCount: 0,
    })
    expect(fake.queries.map(({ sql }) => sql)).toContain('ROLLBACK')
    expect(fake.queries.map(({ sql }) => sql).join('\n')).toContain('pg_advisory_unlock')
  })

  test('accepts only the same resumable RFC-349 operation', async () => {
    const tables = [{ table_schema: 'agent_workflow_meta', table_name: 'logical_copy_operations' }]
    const accepted = fakeRuntime({ tables, operations: [{ operation_id: 'dbm_resume_12345678' }] })
    await expect(
      preflightPostgresqlTarget({ runtime: accepted.runtime, operationId: 'dbm_resume_12345678' }),
    ).resolves.toMatchObject({ targetState: 'resumable', metadataTableCount: 1 })

    const rejected = fakeRuntime({ tables, operations: [] })
    await expect(
      preflightPostgresqlTarget({ runtime: rejected.runtime, operationId: 'dbm_resume_12345678' }),
    ).rejects.toMatchObject({ code: 'postgresql-target-not-empty' })
  })

  test('rejects unsupported environment and held advisory locks with stable categories', async () => {
    const unsupported = fakeRuntime({
      environment: {
        server_version_num: '140012',
        server_encoding: 'UTF8',
        timezone: 'UTC',
        database_bytes: '8192',
        has_c_collation: true,
      },
    })
    await expect(
      preflightPostgresqlTarget({
        runtime: unsupported.runtime,
        operationId: 'dbm_preflight_version_01',
      }),
    ).rejects.toMatchObject({ code: 'postgresql-version-unsupported' })

    const held = fakeRuntime({ lockAcquired: false })
    await expect(
      preflightPostgresqlTarget({ runtime: held.runtime, operationId: 'dbm_preflight_lock_01' }),
    ).rejects.toMatchObject({ code: 'postgresql-advisory-lock-held' })
  })

  test('maps probe failures without leaking a driver URL and still rolls back', async () => {
    const fake = fakeRuntime({ failWhenSqlIncludes: 'CREATE TABLE' })
    try {
      await preflightPostgresqlTarget({
        runtime: fake.runtime,
        operationId: 'dbm_preflight_failure_01',
      })
      throw new Error('expected preflight failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresqlPreflightError)
      expect(error).toMatchObject({ code: 'postgresql-permission-probe-failed' })
      expect(String(error)).not.toContain('secret')
    }
    expect(fake.queries.map(({ sql }) => sql)).toContain('ROLLBACK')
  })
})
