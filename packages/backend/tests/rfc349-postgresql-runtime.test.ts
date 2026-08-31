// RFC-349 T3 — locks the external PostgreSQL pool boundary: URL secrets never
// enter observable errors, readiness uses a reserved/configured connection,
// advisory locks remain session-scoped, and shutdown is idempotent.

import { describe, expect, test } from 'bun:test'
import type { DatabaseConfig } from '@agent-workflow/shared'
import {
  createPostgresqlDatabaseRuntime,
  PostgresqlRuntimeError,
  type PostgresqlPool,
  type PostgresqlPoolOptions,
  type PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'

type PostgresqlConfig = Extract<DatabaseConfig, { provider: 'postgresql' }>

const config: PostgresqlConfig = {
  provider: 'postgresql',
  urlEnv: 'RFC349_DATABASE_URL',
  poolMax: 9,
  connectTimeoutMs: 2_500,
  statementTimeoutMs: 12_345,
  idleTimeoutMs: 45_678,
}

function rows(value: readonly Record<string, unknown>[]) {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

function fakePool(input: {
  readonly responses?: readonly (readonly Record<string, unknown>[])[]
  readonly reserveError?: unknown
}) {
  const queries: Array<{ sql: string; parameters: readonly unknown[] | undefined }> = []
  let responseIndex = 0
  let releases = 0
  let closes = 0
  const connection: PostgresqlReservedConnection = {
    unsafe(sql, parameters) {
      queries.push({ sql, parameters })
      return rows(input.responses?.[responseIndex++] ?? [])
    },
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      if (input.reserveError !== undefined) throw input.reserveError
      return connection
    },
    unsafe(sql, parameters) {
      queries.push({ sql, parameters })
      return rows([])
    },
    async close() {
      closes += 1
    },
  }
  return {
    pool,
    queries,
    get releases() {
      return releases
    },
    get closes() {
      return closes
    },
  }
}

describe('RFC-349 PostgreSQL runtime', () => {
  test('requires a named postgresql URL without echoing the secret', () => {
    expect(() =>
      createPostgresqlDatabaseRuntime({ config, generationId: 'dbg_pg_01', env: {} }),
    ).toThrow('RFC349_DATABASE_URL')

    const secret = 'not-a-postgresql-url-with-password'
    try {
      createPostgresqlDatabaseRuntime({
        config,
        generationId: 'dbg_pg_01',
        env: { RFC349_DATABASE_URL: secret },
      })
      throw new Error('expected invalid URL')
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresqlRuntimeError)
      expect(String(error)).not.toContain(secret)
      expect((error as PostgresqlRuntimeError).code).toBe('postgresql-url-invalid')
    }
  })

  test('constructs a lazy bounded pool with server-side timeout options', () => {
    const fake = fakePool({})
    let captured: PostgresqlPoolOptions | undefined
    createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://user:secret@db.example/app?sslmode=require' },
      poolFactory(options) {
        captured = options
        return fake.pool
      },
    })

    expect(captured?.max).toBe(9)
    expect(captured?.connectionTimeout).toBe(3)
    expect(captured?.idleTimeout).toBe(46)
    const parsed = new URL(captured!.url)
    expect(parsed.searchParams.get('sslmode')).toBe('require')
    expect(parsed.searchParams.get('options')).toContain('-c statement_timeout=12345')
    expect(parsed.searchParams.get('options')).toContain('-c lock_timeout=12345')
    expect(parsed.searchParams.get('options')).toContain(
      '-c idle_in_transaction_session_timeout=45678',
    )
  })

  test('health configures and releases a reserved connection and returns a safe fingerprint', async () => {
    const fake = fakePool({
      responses: [
        [],
        [
          {
            database_name: 'agent_workflow',
            server_address: '10.0.0.1',
            server_port: 5432,
            server_version_num: '170004',
            server_version: 'PostgreSQL 17.4',
          },
        ],
      ],
    })
    const runtime = createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://user:secret@db.example/app' },
      poolFactory: () => fake.pool,
    })

    const health = await runtime.readiness()
    expect(health).toMatchObject({
      provider: 'postgresql',
      generationId: 'dbg_pg_01',
      ok: true,
      serverVersion: 'PostgreSQL 17.4',
      errorCategory: null,
    })
    expect(health.databaseFingerprint).toMatch(/^pg:[a-f0-9]{24}$/)
    expect(JSON.stringify(health)).not.toContain('secret')
    expect(fake.queries[0]?.sql).toContain("set_config('statement_timeout'")
    expect(fake.queries[1]?.sql).toContain('current_database()')
    expect(fake.releases).toBe(1)
  })

  test('categorizes readiness timeout without leaking the driver failure', async () => {
    const fake = fakePool({ reserveError: new DOMException('socket secret', 'TimeoutError') })
    const runtime = createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://user:secret@db.example/app' },
      poolFactory: () => fake.pool,
    })

    expect(await runtime.health()).toMatchObject({ ok: false, errorCategory: 'timeout' })
    await expect(runtime.readiness()).rejects.toThrow('PostgreSQL readiness failed (timeout)')
  })

  test('holds an advisory lock on one reserved session and releases it exactly once', async () => {
    const fake = fakePool({ responses: [[], [{ acquired: true }], [{ released: true }]] })
    const runtime = createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://db.example/app' },
      poolFactory: () => fake.pool,
    })

    const lock = await runtime.acquireMigrationAdvisoryLock('dbm_operation_1234')
    expect(lock?.operationId).toBe('dbm_operation_1234')
    expect(fake.releases).toBe(0)
    await lock?.release()
    await lock?.release()
    expect(fake.queries.map((query) => query.sql).join('\n')).toContain('pg_advisory_unlock')
    expect(fake.releases).toBe(1)
  })

  test('returns null when another owner holds the target lock', async () => {
    const fake = fakePool({ responses: [[], [{ acquired: false }]] })
    const runtime = createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://db.example/app' },
      poolFactory: () => fake.pool,
    })

    expect(await runtime.acquireMigrationAdvisoryLock('dbm_operation_1234')).toBeNull()
    expect(fake.releases).toBe(1)
  })

  test('shutdown is idempotent and every post-close capability fails closed', async () => {
    const fake = fakePool({})
    const runtime = createPostgresqlDatabaseRuntime({
      config,
      generationId: 'dbg_pg_01',
      env: { RFC349_DATABASE_URL: 'postgresql://db.example/app' },
      poolFactory: () => fake.pool,
    })

    expect(runtime.providerPool()).toBe(fake.pool)
    await runtime.close()
    await runtime.close()
    expect(fake.closes).toBe(1)
    expect(await runtime.health()).toMatchObject({ ok: false, errorCategory: 'closed' })
    expect(() => runtime.providerPool()).toThrow('PostgreSQL runtime is closed')
    await expect(runtime.acquireMigrationAdvisoryLock('dbm_operation_1234')).rejects.toThrow(
      'PostgreSQL runtime is closed',
    )
  })
})
