import type { DbClient } from '../../src/db/client'
import { SqliteMemoryInjectionReadStore } from '../../src/modules/memory/infrastructure/sqliteMemoryInjectionReadStore'
import type { MemoryInjectionQueries } from '../../src/modules/memory/public/queries'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from '../../src/modules/memory/application/injection/injectMemory'

export function sqliteMemoryInjectionStore(db: DbClient): SqliteMemoryInjectionReadStore {
  return new SqliteMemoryInjectionReadStore(db)
}

export function sqliteMemoryInjectionQueries(db: DbClient): MemoryInjectionQueries {
  const store = sqliteMemoryInjectionStore(db)
  return Object.freeze({
    injectForRun: async (input: Parameters<MemoryInjectionQueries['injectForRun']>[0]) =>
      await injectMemoryForRun({ ...input, store }),
    loadFirstAttemptSnapshot: async (
      input: Parameters<MemoryInjectionQueries['loadFirstAttemptSnapshot']>[0],
    ) => await loadInjectedSnapshotFromFirstAttempt(store, input),
  })
}
