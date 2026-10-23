import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ResourcePackageApplyJournalPort } from '../application/resourcePackageMaintenance'
import { createResourcePackageAtomicJournal } from './resourcePackageAtomicJournal'

export function createResourcePackageApplyJournalPort(
  db: PersistenceDb,
): ResourcePackageApplyJournalPort {
  const journal = createResourcePackageAtomicJournal(db)
  return {
    // RFC-395 II-a: retain HEAD's frozen collection as well as each frozen snapshot.
    list: async () => Object.freeze((await journal.list()).map((row) => Object.freeze({ ...row }))),
    compareAndSet: (row, patch) =>
      journal.transaction((tx) => journal.compareAndSet(tx, row.id, row.state, patch)),
  }
}
