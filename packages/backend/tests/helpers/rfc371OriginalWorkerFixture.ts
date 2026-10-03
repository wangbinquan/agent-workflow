// Full-report Worker tests use a file SQLite source or one real max=1 PostgreSQL serving pool.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '@/db/client'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'
import type { OriginalReportDatabaseBinding } from '@/platform/persistence/reportSnapshot'
import type { ProviderHarness } from './eachProvider'
import { seedCompleteTask } from './rfc371CompleteTaskFixture'

export type ReportCleanupFault = 'ROLLBACK' | 'DROP TABLE' | 'pg_advisory_unlock'

/** All statements reach the real reserved driver; only the named cleanup acknowledgement fails. */
class OriginalCleanupConnection implements PostgresqlReservedConnection {
  private reader = false
  constructor(
    private readonly original: PostgresqlReservedConnection,
    private readonly events: string[],
    private readonly fault: { value: ReportCleanupFault | undefined },
  ) {}
  unsafe(statement: string, parameters?: readonly unknown[]) {
    if (statement.includes('CREATE TEMP TABLE aw_report_workspace')) this.reader = true
    if (this.reader && this.fault.value && statement.includes(this.fault.value)) {
      this.events.push('cleanup-fault:' + this.fault.value)
      this.fault.value = undefined
      throw new Error('Injected original channel cleanup acknowledgement failure')
    }
    return this.original.unsafe(statement, parameters)
  }
  release() {
    this.events.push(this.reader ? 'reader-released' : 'writer-released')
    this.original.release()
  }
  async close(options?: { readonly timeout?: number }) {
    this.events.push(this.reader ? 'reader-physical-close' : 'writer-physical-close')
    if (!this.original.close) throw new Error('Native original reserved close unavailable')
    await this.original.close(options)
  }
}

class OriginalCleanupPool implements PostgresqlPool {
  constructor(
    private readonly original: PostgresqlPool,
    private readonly events: string[],
    private readonly fault: { value: ReportCleanupFault | undefined },
  ) {}
  unsafe(statement: string, parameters?: readonly unknown[]) {
    return this.original.unsafe(statement, parameters)
  }
  close(options?: { readonly timeout?: number }) {
    return this.original.close(options)
  }
  async reserve(options?: { readonly signal?: AbortSignal }) {
    const original = await this.original.reserve(options)
    this.events.push('reserved')
    return new OriginalCleanupConnection(original, this.events, this.fault)
  }
}
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
  const selected = createPostgresqlDatabaseRuntime({
    config: { ...original.databaseConfig, poolMax: 1 },
    generationId: original.runtime.generationId,
    poolFactory: () => new OriginalCleanupPool(pool, events, { value: options.cleanupFault }),
  })
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
      await selected.close()
      await native.close()
      rmSync(appHome, { recursive: true, force: true })
    },
  }
}
