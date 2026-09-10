import type { ProviderNeutralDatabase } from '../../src/db/query'
import { DrizzleMemoryInjectionReadStore } from '../../src/modules/memory/infrastructure/memoryInjectionReadStore'
import type { MemoryInjectionQueries } from '../../src/modules/memory/public/queries'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from '../../src/modules/memory/application/injection/injectMemory'

export function sqliteMemoryInjectionStore(
  db: ProviderNeutralDatabase,
): DrizzleMemoryInjectionReadStore {
  return new DrizzleMemoryInjectionReadStore(db)
}

export function sqliteMemoryInjectionQueries(db: ProviderNeutralDatabase): MemoryInjectionQueries {
  const store = sqliteMemoryInjectionStore(db)
  return Object.freeze({
    injectForRun: async (input: Parameters<MemoryInjectionQueries['injectForRun']>[0]) =>
      await injectMemoryForRun({ ...input, store }),
    loadFirstAttemptSnapshot: async (
      input: Parameters<MemoryInjectionQueries['loadFirstAttemptSnapshot']>[0],
    ) => await loadInjectedSnapshotFromFirstAttempt(store, input),
  })
}
