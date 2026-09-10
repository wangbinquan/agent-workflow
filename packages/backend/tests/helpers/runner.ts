import {
  runNode as runNodeWithProvider,
  type RunNodeOptions as ProviderRunNodeOptions,
} from '../../src/services/runner'
import { sqliteMemoryInjectionQueries } from './memoryInjection'
import { createRuntimeSessionLeaseOperations } from '../../src/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { createTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import { composeRuntimeRegistryOperations } from '../../src/platform/runtime-registry/composition'

export * from '../../src/services/runner'

/**
 * Provider-selected test composition for the production-required memory read participant.
 * Production callers must inject their selected provider explicitly.
 */
export type RunNodeOptions = Omit<
  ProviderRunNodeOptions,
  'memoryInjectionQueries' | 'runtimeSessionLeases' | 'persistence' | 'runtimeRegistry'
> &
  Readonly<{ db: ProviderNeutralDatabase }> &
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
    runtimeSessionLeases: options.runtimeSessionLeases ?? createRuntimeSessionLeaseOperations(db),
    persistence: options.persistence ?? createTaskExecutionPersistence(db),
    runtimeRegistry: options.runtimeRegistry ?? composeRuntimeRegistryOperations(db),
  })
}
