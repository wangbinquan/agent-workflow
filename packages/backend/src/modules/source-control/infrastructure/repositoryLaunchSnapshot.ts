import type { RepositoryWorkspaceTaskPorts } from '../composition/required-ports'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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
    readonly taskPorts: RepositoryWorkspaceTaskPorts
    readonly transaction: PersistenceDb
  },
) {
  return createRepositoryLaunchSnapshot({
    ...input,
    journal: createRepositoryPreparationJournal(input.transaction),
    store: composeRepositoryWorkspaceStore(input.transaction, input.taskPorts),
  })
}
export function readRepositoryPreparationFacts(
  db: PersistenceDb,
  reference: FrozenRepositoryPreparationRef,
) {
  return readRepositoryPreparationFactsFromJournal(
    createRepositoryPreparationJournal(db),
    reference,
  )
}
