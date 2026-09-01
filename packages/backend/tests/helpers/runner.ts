import {
  runNode as runNodeWithProvider,
  type RunNodeOptions as ProviderRunNodeOptions,
} from '../../src/services/runner'
import { sqliteMemoryInjectionQueries } from './memoryInjection'
import { createSqliteRuntimeSessionLeaseOperations } from '../../src/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'
import type { DbClient } from '../../src/db/client'
import { createSqliteTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import { composeSqliteRuntimeRegistryOperations } from '../../src/platform/runtime-registry/composition'

export * from '../../src/services/runner'

/**
 * SQLite test composition for the production-required memory read participant.
 * Production callers must inject their selected provider explicitly.
 */
export type RunNodeOptions = Omit<
  ProviderRunNodeOptions,
  'memoryInjectionQueries' | 'runtimeSessionLeases' | 'persistence' | 'runtimeRegistry'
> &
  Readonly<{ db: DbClient }> &
  Partial<
    Pick<
      ProviderRunNodeOptions,
      'memoryInjectionQueries' | 'runtimeSessionLeases' | 'persistence' | 'runtimeRegistry'
    >
  >

export async function runNode(options: RunNodeOptions) {
  const { db, ...providerOptions } = options
  return await runNodeWithProvider({
    ...providerOptions,
    memoryInjectionQueries: options.memoryInjectionQueries ?? sqliteMemoryInjectionQueries(db),
    runtimeSessionLeases:
      options.runtimeSessionLeases ?? createSqliteRuntimeSessionLeaseOperations(db),
    persistence: options.persistence ?? createSqliteTaskExecutionPersistence(db),
    runtimeRegistry: options.runtimeRegistry ?? composeSqliteRuntimeRegistryOperations(db),
  })
}
