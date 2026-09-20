import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createRepositoryLaunchSnapshot,
  readRepositoryPreparationFactsFromJournal,
} from '../application/repositoryLaunchSnapshot'
import type { FrozenRepositoryPreparationRef } from '../public/types'
import { createRepositoryPreparationJournal } from './repositoryPreparationJournal'
import { composeRepositoryWorkspaceStore } from './repositoryWorkspaceStore'

/** Binds the caller's existing live transaction; never opens a second scope. */
export function createRepositoryLaunchSnapshotInTx(
  input: Omit<Parameters<typeof createRepositoryLaunchSnapshot>[0], 'journal' | 'store'> & {
    readonly transaction: ProviderNeutralDatabase
  },
) {
  return createRepositoryLaunchSnapshot({
    ...input,
    journal: createRepositoryPreparationJournal(input.transaction),
    store: composeRepositoryWorkspaceStore(input.transaction),
  })
}
export function readRepositoryPreparationFacts(
  db: ProviderNeutralDatabase,
  reference: FrozenRepositoryPreparationRef,
) {
  return readRepositoryPreparationFactsFromJournal(
    createRepositoryPreparationJournal(db),
    reference,
  )
}
