// RFC-349 — external PostgreSQL pool/runtime adapter built on Bun.SQL.
// The connection URL is resolved once from the configured environment-variable
// name and is never retained in status, errors, logs, manifests or receipts.

import { SQL } from 'bun'
import type { DatabaseConfig, DatabaseRuntimeTelemetry } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { timeoutSignal } from '@/util/timeoutSignal'
import type { DatabaseHealth, DatabaseRuntime } from './runtime'

type PostgresqlConfig = Extract<DatabaseConfig, { provider: 'postgresql' }>

export interface SqlRows extends PromiseLike<readonly Record<string, unknown>[]> {
  values(): Promise<readonly (readonly unknown[])[]>
}

export interface PostgresqlReservedConnection {
  unsafe(query: string, parameters?: readonly unknown[]): SqlRows
  release(): void
}

export interface PostgresqlPool {
  reserve(options?: { readonly signal?: AbortSignal }): Promise<PostgresqlReservedConnection>
  unsafe(query: string, parameters?: readonly unknown[]): SqlRows
  close(options?: { readonly timeout?: number }): Promise<void>
}

export interface PostgresqlPoolOptions {
  readonly url: string
  readonly max: number
  readonly idleTimeout: number
  readonly connectionTimeout: number
}

export interface PostgresqlAdvisoryLock {
  readonly operationId: string
  release(): Promise<void>
}

export interface PostgresqlDatabaseRuntime extends DatabaseRuntime {
  readonly provider: 'postgresql'
  readiness(): Promise<
    DatabaseHealth & {
      readonly ok: true
      readonly databaseFingerprint: string
      readonly serverVersion: string
      readonly errorCategory: null
    }
  >
  acquireMigrationAdvisoryLock(operationId: string): Promise<PostgresqlAdvisoryLock | null>
  /** Bootstrap/infrastructure-only capability. Never export through a module public surface. */
  providerPool(): PostgresqlPool
}

export interface PostgresqlRuntimeTelemetrySnapshot extends DatabaseRuntimeTelemetry {
  readonly provider: 'postgresql'
  readonly poolWait: NonNullable<DatabaseRuntimeTelemetry['poolWait']>
}

export interface InstrumentedPostgresqlDatabaseRuntime extends PostgresqlDatabaseRuntime {
  /** Closed mechanism snapshot; never exposes the URL, SQL text, or pool handle. */
  telemetry(): PostgresqlRuntimeTelemetrySnapshot
}

export class PostgresqlRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-url-env-missing'
      | 'postgresql-url-invalid'
      | 'postgresql-readiness-failed'
      | 'postgresql-runtime-closed'
      | 'postgresql-advisory-lock-failed',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlRuntimeError'
  }
}

function seconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000))
}

const POOL_WAIT_TELEMETRY_WINDOW_MS = 10 * 60_000
const POOL_WAIT_TELEMETRY_SAMPLE_LIMIT = 100_000

interface PoolWaitSample {
  readonly at: number
  readonly waitMs: number
  readonly acquired: boolean
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

function createPoolWaitTelemetry(input: {
  readonly wallNow: () => number
  readonly monotonicNow: () => number
}) {
  const samples: PoolWaitSample[] = []

  const prune = (now: number): void => {
    const cutoff = now - POOL_WAIT_TELEMETRY_WINDOW_MS
    let remove = 0
    while (samples[remove]?.at !== undefined && samples[remove]!.at < cutoff) remove += 1
    if (remove > 0) samples.splice(0, remove)
    if (samples.length > POOL_WAIT_TELEMETRY_SAMPLE_LIMIT) {
      samples.splice(0, samples.length - POOL_WAIT_TELEMETRY_SAMPLE_LIMIT)
    }
  }

  return Object.freeze({
    async reserve(
      pool: PostgresqlPool,
      options?: { readonly signal?: AbortSignal },
    ): Promise<PostgresqlReservedConnection> {
      const startedAt = input.monotonicNow()
      let acquired = false
      try {
        const connection = await pool.reserve(options)
        acquired = true
        return connection
      } finally {
        const at = input.wallNow()
        samples.push({
          at,
          waitMs: Math.max(0, input.monotonicNow() - startedAt),
          acquired,
        })
        prune(at)
      }
    },
    snapshot(): PostgresqlRuntimeTelemetrySnapshot {
      prune(input.wallNow())
      const waits = samples.map((sample) => sample.waitMs).sort((left, right) => left - right)
      const acquiredCount = samples.reduce((count, sample) => count + (sample.acquired ? 1 : 0), 0)
      return Object.freeze({
        version: 1,
        provider: 'postgresql',
        poolWait: Object.freeze({
          windowMs: POOL_WAIT_TELEMETRY_WINDOW_MS,
          sampleCount: samples.length,
          acquiredCount,
          failedCount: samples.length - acquiredCount,
          p50Ms: percentile(waits, 0.5),
          p95Ms: percentile(waits, 0.95),
          maxMs: waits.at(-1) ?? 0,
        }),
      })
    },
  })
}

function safeUrl(
  config: PostgresqlConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env[config.urlEnv]
  if (value === undefined || value.trim() === '') {
    throw new PostgresqlRuntimeError(
      'postgresql-url-env-missing',
      `PostgreSQL connection environment variable is missing: ${config.urlEnv}`,
    )
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error()
  } catch {
    throw new PostgresqlRuntimeError(
      'postgresql-url-invalid',
      `PostgreSQL connection environment variable is not a postgresql:// URL: ${config.urlEnv}`,
    )
  }
  return value
}

function defaultPoolFactory(options: PostgresqlPoolOptions): PostgresqlPool {
  return new SQL({
    url: options.url,
    max: options.max,
    idleTimeout: options.idleTimeout,
    connectionTimeout: options.connectionTimeout,
  }) as unknown as PostgresqlPool
}

function urlWithServerTimeouts(url: string, config: PostgresqlConfig): string {
  const parsed = new URL(url)
  const existing = parsed.searchParams.get('options')?.trim()
  const settings = [
    existing,
    `-c statement_timeout=${config.statementTimeoutMs}`,
    `-c lock_timeout=${config.statementTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${config.idleTimeoutMs}`,
    '-c search_path=agent_workflow,public',
    '-c timezone=UTC',
  ]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' ')
  parsed.searchParams.set('options', settings)
  return parsed.toString()
}

function fingerprint(row: Record<string, unknown>): string {
  const stable = [
    String(row.database_name ?? ''),
    String(row.server_address ?? ''),
    String(row.server_port ?? ''),
    String(row.server_version_num ?? ''),
  ].join('\0')
  return `pg:${sha256Hex(stable).slice(0, 24)}`
}

function errorCategory(error: unknown): DatabaseHealth['errorCategory'] {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
  if (error instanceof Error && /timeout/i.test(error.name)) return 'timeout'
  return 'unavailable'
}

async function configureConnection(
  connection: PostgresqlReservedConnection,
  config: PostgresqlConfig,
): Promise<void> {
  await connection.unsafe(
    "SELECT set_config('statement_timeout', $1, false), " +
      "set_config('lock_timeout', $2, false), " +
      "set_config('idle_in_transaction_session_timeout', $3, false), " +
      "set_config('search_path', $4, false), " +
      "set_config('timezone', $5, false)",
    [
      String(config.statementTimeoutMs),
      String(config.statementTimeoutMs),
      String(config.idleTimeoutMs),
      'agent_workflow,public',
      'UTC',
    ],
  )
}

export function createPostgresqlDatabaseRuntime(input: {
  readonly config: PostgresqlConfig
  readonly generationId: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly poolFactory?: (options: PostgresqlPoolOptions) => PostgresqlPool
  readonly telemetryWallNow?: () => number
  readonly telemetryMonotonicNow?: () => number
}): InstrumentedPostgresqlDatabaseRuntime {
  const url = safeUrl(input.config, input.env ?? process.env)
  const factory = input.poolFactory ?? defaultPoolFactory
  // Bun.SQL is lazy: constructing this object does not open a connection. The
  // URL is captured only by the native pool closure and never copied to an
  // observable DTO/error field owned by agent-workflow.
  const physicalPool = factory({
    url: urlWithServerTimeouts(url, input.config),
    max: input.config.poolMax,
    idleTimeout: seconds(input.config.idleTimeoutMs),
    connectionTimeout: seconds(input.config.connectTimeoutMs),
  })
  const poolWaitTelemetry = createPoolWaitTelemetry({
    wallNow: input.telemetryWallNow ?? Date.now,
    monotonicNow: input.telemetryMonotonicNow ?? (() => performance.now()),
  })
  const pool: PostgresqlPool = Object.freeze({
    reserve: (options: Parameters<PostgresqlPool['reserve']>[0]) =>
      poolWaitTelemetry.reserve(physicalPool, options),
    unsafe: physicalPool.unsafe.bind(physicalPool),
    close: physicalPool.close.bind(physicalPool),
  })
  let closed = false

  const health = async (): Promise<DatabaseHealth> => {
    if (closed) {
      return {
        provider: 'postgresql',
        generationId: input.generationId,
        ok: false,
        latencyMs: 0,
        databaseFingerprint: null,
        serverVersion: null,
        errorCategory: 'closed',
      }
    }
    const startedAt = performance.now()
    let connection: PostgresqlReservedConnection | undefined
    const deadline = timeoutSignal(input.config.connectTimeoutMs)
    try {
      try {
        connection = await pool.reserve({ signal: deadline.signal })
      } finally {
        deadline.cancel()
      }
      await configureConnection(connection, input.config)
      const rows = await connection.unsafe(
        'SELECT current_database() AS database_name, ' +
          'inet_server_addr()::text AS server_address, ' +
          'inet_server_port() AS server_port, ' +
          "current_setting('server_version_num') AS server_version_num, " +
          'version() AS server_version',
      )
      const row = rows[0]
      if (row === undefined) throw new Error('empty readiness result')
      return {
        provider: 'postgresql',
        generationId: input.generationId,
        ok: true,
        latencyMs: Math.max(0, performance.now() - startedAt),
        databaseFingerprint: fingerprint(row),
        serverVersion: String(row.server_version ?? ''),
        errorCategory: null,
      }
    } catch (error) {
      return {
        provider: 'postgresql',
        generationId: input.generationId,
        ok: false,
        latencyMs: Math.max(0, performance.now() - startedAt),
        databaseFingerprint: null,
        serverVersion: null,
        errorCategory: errorCategory(error),
      }
    } finally {
      connection?.release()
    }
  }

  const runtime: InstrumentedPostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: input.generationId,
    health,
    async readiness() {
      const result = await health()
      if (!result.ok) {
        throw new PostgresqlRuntimeError(
          'postgresql-readiness-failed',
          `PostgreSQL readiness failed (${result.errorCategory ?? 'unavailable'})`,
        )
      }
      return result as DatabaseHealth & {
        readonly ok: true
        readonly databaseFingerprint: string
        readonly serverVersion: string
        readonly errorCategory: null
      }
    },
    async acquireMigrationAdvisoryLock(operationId) {
      if (!/^dbm_[A-Za-z0-9_-]{8,128}$/.test(operationId)) {
        throw new PostgresqlRuntimeError(
          'postgresql-advisory-lock-failed',
          'invalid PostgreSQL migration advisory-lock operation id',
        )
      }
      if (closed) {
        throw new PostgresqlRuntimeError(
          'postgresql-runtime-closed',
          'PostgreSQL runtime is closed',
        )
      }
      const deadline = timeoutSignal(input.config.connectTimeoutMs)
      let connection: PostgresqlReservedConnection
      try {
        connection = await pool.reserve({ signal: deadline.signal })
      } finally {
        deadline.cancel()
      }
      let held = false
      try {
        await configureConnection(connection, input.config)
        const rows = await connection.unsafe(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [operationId],
        )
        held = rows[0]?.acquired === true
        if (!held) {
          connection.release()
          return null
        }
        let released = false
        return Object.freeze({
          operationId,
          async release() {
            if (released) return
            released = true
            try {
              await connection.unsafe(
                'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
                [operationId],
              )
            } finally {
              connection.release()
            }
          },
        })
      } catch {
        if (held) {
          try {
            await connection.unsafe(
              'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
              [operationId],
            )
          } catch {
            // The session-scoped advisory lock is released by PostgreSQL when
            // this reserved connection closes. Never retain a poisoned pool
            // connection merely because the explicit unlock also failed.
          }
        }
        connection.release()
        throw new PostgresqlRuntimeError(
          'postgresql-advisory-lock-failed',
          `PostgreSQL migration advisory lock failed for ${operationId}`,
        )
      }
    },
    providerPool() {
      if (closed) {
        throw new PostgresqlRuntimeError(
          'postgresql-runtime-closed',
          'PostgreSQL runtime is closed',
        )
      }
      return pool
    },
    telemetry: poolWaitTelemetry.snapshot,
    async close() {
      if (closed) return
      closed = true
      await pool.close({ timeout: seconds(input.config.idleTimeoutMs) })
    },
  }
  return Object.freeze(runtime)
}
