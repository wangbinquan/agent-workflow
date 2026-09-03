// RFC-349 — provider-specific database doctor and storage-maintenance
// mechanisms. Business retention remains owner application work; this adapter
// prevents SQLite PRAGMA/VACUUM machinery from ever reaching PostgreSQL.

import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { Database } from 'bun:sqlite'
import {
  openPostgresqlLogicalSource,
  type PostgresqlLogicalSource,
} from './postgresqlLogicalSource'
import type { PostgresqlDatabaseRuntime } from './postgresqlRuntime'
import type { LogicalSchemaContract } from './schemaContract'

export interface DatabaseOperationalCheck {
  readonly code: string
  readonly ok: boolean
  readonly message: string
}

export interface DatabaseDoctorReport {
  readonly provider: DatabaseProvider
  readonly generationId: string
  readonly ok: boolean
  readonly checks: readonly DatabaseOperationalCheck[]
  readonly metrics: Readonly<Record<string, number>>
}

export interface DatabaseStorageMaintenanceReceipt {
  readonly provider: DatabaseProvider
  readonly mechanism: 'sqlite-wal-checkpoint' | 'postgresql-autovacuum-observation'
  readonly counters: Readonly<Record<string, number>>
}

export interface DatabaseOperationalAdapter {
  readonly provider: DatabaseProvider
  doctor(): Promise<DatabaseDoctorReport>
  runStorageMaintenance(): Promise<DatabaseStorageMaintenanceReceipt>
}

function safeCount(value: unknown, detail: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`database operational metric is invalid: ${detail}`)
  }
  return count
}

export function createSqliteDatabaseOperationalAdapter(input: {
  readonly path: string
  readonly generationId: string
}): DatabaseOperationalAdapter {
  return Object.freeze({
    provider: 'sqlite' as const,
    async doctor() {
      const checks: DatabaseOperationalCheck[] = []
      const metrics: Record<string, number> = {}
      let database: Database | undefined
      try {
        database = new Database(input.path, { readonly: true })
        const rows = database.query('PRAGMA quick_check').all() as Array<{
          quick_check: string
        }>
        const ok = rows.length === 1 && rows[0]?.quick_check === 'ok'
        checks.push({
          code: 'sqlite-quick-check',
          ok,
          message: ok ? 'quick_check ok' : 'quick_check reported corruption',
        })
        const pageCount = database.query('PRAGMA page_count').get() as { page_count: number }
        const pageSize = database.query('PRAGMA page_size').get() as { page_size: number }
        metrics.pageCount = safeCount(pageCount.page_count, 'sqlite page count')
        metrics.pageSize = safeCount(pageSize.page_size, 'sqlite page size')
      } catch {
        checks.push({
          code: 'sqlite-open',
          ok: false,
          message: 'SQLite database is unavailable or unreadable',
        })
      } finally {
        database?.close()
      }
      return Object.freeze({
        provider: 'sqlite' as const,
        generationId: input.generationId,
        ok: checks.every((check) => check.ok),
        checks: Object.freeze(checks),
        metrics: Object.freeze(metrics),
      })
    },
    async runStorageMaintenance() {
      const database = new Database(input.path)
      try {
        const row = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
          busy: number
          log: number
          checkpointed: number
        }
        return Object.freeze({
          provider: 'sqlite' as const,
          mechanism: 'sqlite-wal-checkpoint' as const,
          counters: Object.freeze({
            busy: safeCount(row.busy, 'sqlite checkpoint busy'),
            logFrames: safeCount(row.log, 'sqlite checkpoint log frames'),
            checkpointedFrames: safeCount(
              row.checkpointed,
              'sqlite checkpoint checkpointed frames',
            ),
          }),
        })
      } finally {
        database.close()
      }
    },
  })
}

type PostgresqlLogicalSourceFactory = (input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly generationId: string
  readonly contract: LogicalSchemaContract
}) => Promise<PostgresqlLogicalSource>

export function createPostgresqlDatabaseOperationalAdapter(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly contract: LogicalSchemaContract
  readonly openLogicalSource?: PostgresqlLogicalSourceFactory
}): DatabaseOperationalAdapter {
  const sourceFactory = input.openLogicalSource ?? openPostgresqlLogicalSource
  return Object.freeze({
    provider: 'postgresql' as const,
    async doctor() {
      const health = await input.runtime.health()
      const checks: DatabaseOperationalCheck[] = [
        {
          code: 'postgresql-readiness',
          ok: health.ok,
          message: health.ok
            ? `PostgreSQL ready (${health.latencyMs.toFixed(1)} ms)`
            : `PostgreSQL unavailable (${health.errorCategory ?? 'unavailable'})`,
        },
      ]
      const metrics: Record<string, number> = { readinessMs: health.latencyMs }
      if (!health.ok) {
        return Object.freeze({
          provider: 'postgresql' as const,
          generationId: input.runtime.generationId,
          ok: false,
          checks: Object.freeze(checks),
          metrics: Object.freeze(metrics),
        })
      }

      let source: PostgresqlLogicalSource | undefined
      try {
        source = await sourceFactory({
          runtime: input.runtime,
          generationId: input.runtime.generationId,
          contract: input.contract,
        })
        const snapshot = await source.preflight()
        checks.push({
          code: 'postgresql-logical-contract',
          ok: true,
          message: `${input.contract.activeTableCount} active tables match the logical contract`,
        })
        metrics.activeRows = snapshot.totalRows
      } catch {
        checks.push({
          code: 'postgresql-logical-contract',
          ok: false,
          message: 'PostgreSQL schema, migration history, or generation fence differs',
        })
      } finally {
        await source?.close()
      }

      try {
        const rows = await input.runtime
          .providerPool()
          .unsafe(
            'SELECT ' +
              '(SELECT count(*) FROM pg_catalog.pg_constraint c ' +
              'JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace ' +
              "WHERE n.nspname = 'agent_workflow' AND NOT c.convalidated) AS unvalidated_constraints, " +
              '(SELECT count(*) FROM pg_catalog.pg_index i ' +
              'JOIN pg_catalog.pg_class t ON t.oid = i.indrelid ' +
              'JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace ' +
              "WHERE n.nspname = 'agent_workflow' AND NOT i.indisvalid) AS invalid_indexes",
          )
        const unvalidatedConstraints = safeCount(
          rows[0]?.unvalidated_constraints,
          'PostgreSQL unvalidated constraints',
        )
        const invalidIndexes = safeCount(rows[0]?.invalid_indexes, 'PostgreSQL invalid indexes')
        metrics.unvalidatedConstraints = unvalidatedConstraints
        metrics.invalidIndexes = invalidIndexes
        checks.push({
          code: 'postgresql-catalog-validity',
          ok: unvalidatedConstraints === 0 && invalidIndexes === 0,
          message:
            unvalidatedConstraints === 0 && invalidIndexes === 0
              ? 'constraints and indexes valid'
              : `${unvalidatedConstraints} unvalidated constraints, ${invalidIndexes} invalid indexes`,
        })
      } catch {
        checks.push({
          code: 'postgresql-catalog-validity',
          ok: false,
          message: 'PostgreSQL catalog validity probe failed',
        })
      }
      return Object.freeze({
        provider: 'postgresql' as const,
        generationId: input.runtime.generationId,
        ok: checks.every((check) => check.ok),
        checks: Object.freeze(checks),
        metrics: Object.freeze(metrics),
      })
    },
    async runStorageMaintenance() {
      const rows = await input.runtime
        .providerPool()
        .unsafe(
          'SELECT ' +
            'COALESCE(sum(n_dead_tup), 0) AS dead_rows, ' +
            'COALESCE(sum(autovacuum_count), 0) AS autovacuum_runs, ' +
            'COALESCE(sum(autoanalyze_count), 0) AS autoanalyze_runs ' +
            "FROM pg_catalog.pg_stat_user_tables WHERE schemaname = 'agent_workflow'",
        )
      return Object.freeze({
        provider: 'postgresql' as const,
        mechanism: 'postgresql-autovacuum-observation' as const,
        counters: Object.freeze({
          deadRows: safeCount(rows[0]?.dead_rows, 'PostgreSQL dead rows'),
          autovacuumRuns: safeCount(rows[0]?.autovacuum_runs, 'PostgreSQL autovacuum runs'),
          autoanalyzeRuns: safeCount(rows[0]?.autoanalyze_runs, 'PostgreSQL autoanalyze runs'),
        }),
      })
    },
  })
}
