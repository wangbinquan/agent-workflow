import { createAtomicApplyClaimStore } from '@/platform/atomic-apply/infrastructure/claimStore'
import { atomicApplyRecoveryClaims } from '@/platform/atomic-apply/lease'
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
    // RFC-401 T4：恢复先接管 claim，写回以接管令牌 fencing。
    ...atomicApplyRecoveryClaims(journal, createAtomicApplyClaimStore('resource-package')),
  }
}
