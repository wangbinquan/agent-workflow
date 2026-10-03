// Full-report Worker tests use a file SQLite source or one real max=1 PostgreSQL serving pool.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '@/db/client'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import type { OriginalReportDatabaseBinding } from '@/platform/persistence/reportSnapshot'
import type { ProviderHarness } from './eachProvider'
import { seedCompleteTask } from './rfc371CompleteTaskFixture'

export type ReportCleanupFault = 'ROLLBACK' | 'DROP TABLE' | 'pg_advisory_unlock'
export async function originalWorkerFixture(
  harness: ProviderHarness,
  options: { attempts?: number; records?: number; cleanupFault?: ReportCleanupFault } = {},
) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-original-report-worker-'))
  const original = harness.applicationBinding
  if (original.provider === 'sqlite') {
    const db = openDb({
      path: join(appHome, 'original.sqlite'),
      migrationsFolder: resolve(import.meta.dir, '../../db/migrations'),
    })
    try {
      await seedCompleteTask({ ...harness, db }, options.attempts ?? 1, options.records ?? 2)
    } catch (error) {
      db.$client.close()
      rmSync(appHome, { recursive: true, force: true })
      throw error
    }
    return {
      appHome,
      db,
      events: [] as string[],
      binding: {
        provider: 'sqlite' as const,
        db,
        generationId: 'original-worker-generation',
      } satisfies OriginalReportDatabaseBinding,
      async close() {
        db.$client.close()
        rmSync(appHome, { recursive: true, force: true })
      },
    }
  }
  await seedCompleteTask(harness, options.attempts ?? 1, options.records ?? 2)
  const native = createPostgresqlDatabaseRuntime({
    config: { ...original.databaseConfig, poolMax: 1 },
    generationId: original.runtime.generationId,
  })
  const pool = native.providerPool(),
    events: string[] = []
  let fault = options.cleanupFault
  const selected: PostgresqlDatabaseRuntime = {
    ...native,
    providerPool: () =>
      ({
        unsafe: (statement, parameters) => pool.unsafe(statement, parameters),
        close: (options) => pool.close(options),
        async reserve(options) {
          const connection = await pool.reserve(options)
          events.push('reserved')
          let reader = false
          return {
            unsafe(statement, parameters) {
              if (statement.includes('CREATE TEMP TABLE aw_report_workspace')) reader = true
              if (reader && fault && statement.includes(fault)) {
                events.push('cleanup-fault:' + fault)
                fault = undefined
                throw new Error('Injected original channel cleanup acknowledgement failure')
              }
              return connection.unsafe(statement, parameters)
            },
            release() {
              events.push(reader ? 'reader-released' : 'writer-released')
              connection.release()
            },
            async close(options) {
              events.push(reader ? 'reader-physical-close' : 'writer-physical-close')
              if (!connection.close) throw new Error('Native original reserved close unavailable')
              await connection.close(options)
            },
          }
        },
      }) satisfies PostgresqlPool,
  }
  const db = createPostgresqlDatabaseClient(selected)
  return {
    appHome,
    db,
    events,
    binding: {
      provider: 'postgresql' as const,
      runtime: selected,
    } satisfies OriginalReportDatabaseBinding,
    async close() {
      await native.close()
      rmSync(appHome, { recursive: true, force: true })
    },
  }
}
