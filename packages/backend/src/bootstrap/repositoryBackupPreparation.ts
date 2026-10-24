import { createSecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { Paths } from '@/util/paths'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import {
  composeRepositoryWorkspaceStore,
  composeRepositoryWorkspaceOperations,
} from '@/modules/source-control/composition'

export function composeRepositoryBackupPreparation(db: PersistenceDb) {
  return composeRepositoryWorkspaceOperations(
    composeRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db)),
    createSecretBox(Paths.secretKeyFile),
  ).backupPreparation
}
