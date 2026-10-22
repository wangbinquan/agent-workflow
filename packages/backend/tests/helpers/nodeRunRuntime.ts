import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeRuntimeSelectionParticipantInTx } from '@/modules/runtime-management/composition/runtimeSelection'
import { composeNodeRunRuntimePersistence as composeWithSelection } from '@/modules/task-execution/composition/nodeRunRuntime'
import { resolveFrozenRuntimeWith, frozenRuntimeOfSessionWith } from '@/services/nodeRunMint'
export function composeNodeRunRuntimePersistence(db: PersistenceDb) {
  return composeWithSelection(db, composeRuntimeSelectionParticipantInTx)
}
export function resolveFrozenRuntime(
  db: PersistenceDb,
  ...args: Parameters<typeof resolveFrozenRuntimeWith> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  return resolveFrozenRuntimeWith(composeNodeRunRuntimePersistence(db), ...args)
}
export function frozenRuntimeOfSession(db: PersistenceDb, sessionId: string) {
  return frozenRuntimeOfSessionWith(composeNodeRunRuntimePersistence(db), sessionId)
}
