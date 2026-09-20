import type { ProviderNeutralDatabase } from '@/db/query'
import { composeRuntimeSelectionParticipantInTx } from '@/modules/runtime-management/composition/runtimeSelection'
import { composeNodeRunRuntimePersistence as composeWithSelection } from '@/modules/task-execution/composition/nodeRunRuntime'
import { resolveFrozenRuntimeWith, frozenRuntimeOfSessionWith } from '@/services/nodeRunMint'
export function composeNodeRunRuntimePersistence(db: ProviderNeutralDatabase) {
  return composeWithSelection(db, composeRuntimeSelectionParticipantInTx)
}
export function resolveFrozenRuntime(
  db: ProviderNeutralDatabase,
  ...args: Parameters<typeof resolveFrozenRuntimeWith> extends [unknown, ...infer Rest]
    ? Rest
    : never
) {
  return resolveFrozenRuntimeWith(composeNodeRunRuntimePersistence(db), ...args)
}
export function frozenRuntimeOfSession(db: ProviderNeutralDatabase, sessionId: string) {
  return frozenRuntimeOfSessionWith(composeNodeRunRuntimePersistence(db), sessionId)
}
