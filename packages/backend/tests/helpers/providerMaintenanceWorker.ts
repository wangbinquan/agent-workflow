import { join } from 'node:path'

import { openDb } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  MaintenanceWorkerDatabaseInit,
  MaintenanceWorkerSupervisorOptions,
} from '@/platform/background/maintenanceWorkerSupervisor'
import type { ProviderDatabaseHarness } from './eachProvider'
import { MIGRATIONS } from '../migration-freeze'

export interface ProviderMaintenanceWorkerDatabase {
  readonly db: ProviderNeutralDatabase
  readonly databaseInit: MaintenanceWorkerDatabaseInit
  readonly workerFactory?: MaintenanceWorkerSupervisorOptions['workerFactory']
  dispose(): Promise<void>
}

/** The actual Worker needs a shared file rather than the harness's in-memory connection. */
export function openProviderMaintenanceWorkerDatabase(
  harness: ProviderDatabaseHarness,
  appHome: string,
): ProviderMaintenanceWorkerDatabase {
  const binding = harness.applicationBinding
  if (binding.provider === 'postgresql') {
    return Object.freeze({
      db: binding.db,
      databaseInit: Object.freeze({
        provider: 'postgresql' as const,
        generationId: binding.runtime.generationId,
        database: binding.databaseConfig,
      }),
      // The real thread uses the current per-file database environment at creation.
      workerFactory() {
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value
        }
        return new Worker(
          new URL('../../src/platform/background/maintenanceWorker.ts', import.meta.url).href,
          { env },
        )
      },
      async dispose() {},
    })
  }
  const dbPath = join(appHome, 'db.sqlite')
  const db = openDb({
    path: dbPath,
    migrationsFolder: MIGRATIONS,
    skipIntegrityCheck: true,
    slowQueryMs: 0,
  })
  return Object.freeze({
    db,
    databaseInit: Object.freeze({
      dbPath,
      migrationsFolder: MIGRATIONS,
      sqlite: Object.freeze({
        synchronous: 'NORMAL' as const,
        pageCacheMib: 8,
        mmapMib: 0,
        busyTimeoutMs: 50,
      }),
    }),
    async dispose() {
      ;(db as unknown as { $client: { close(): void } }).$client.close()
    },
  })
}
