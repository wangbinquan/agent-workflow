import { createRepositoryIdentityQueries } from '@/modules/source-control/infrastructure/repositoryIdentityQueries'
import { createNodeRunQueries } from '@/modules/task-execution/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { DrizzleMemoryInjectionReadStore } from '../../src/modules/memory/infrastructure/memoryInjectionReadStore'
import type { MemoryInjectionQueries } from '../../src/modules/memory/public/queries'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from '../../src/modules/memory/application/injection/injectMemory'
import { taskKnowledgeQueriesFor } from './taskKnowledge'

/**
 * The injection read store as bootstrap builds it (RFC-485 / RFC-565): Task Execution's node-run and knowledge reads and
 * Source Control's repository identity read, each on the same handle. Works for either provider.
 */
export function memoryInjectionReadStoreFor(db: PersistenceDb): DrizzleMemoryInjectionReadStore {
  return new DrizzleMemoryInjectionReadStore(
    db,
    createNodeRunQueries(db),
    taskKnowledgeQueriesFor(db),
    createRepositoryIdentityQueries(db),
  )
}

export function sqliteMemoryInjectionStore(db: PersistenceDb): DrizzleMemoryInjectionReadStore {
  return memoryInjectionReadStoreFor(db)
}

export function sqliteMemoryInjectionQueries(db: PersistenceDb): MemoryInjectionQueries {
  const store = sqliteMemoryInjectionStore(db)
  return Object.freeze({
    injectForRun: async (input: Parameters<MemoryInjectionQueries['injectForRun']>[0]) =>
      await injectMemoryForRun({ ...input, store }),
    loadFirstAttemptSnapshot: async (
      input: Parameters<MemoryInjectionQueries['loadFirstAttemptSnapshot']>[0],
    ) => await loadInjectedSnapshotFromFirstAttempt(store, input),
  })
}
