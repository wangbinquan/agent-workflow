// RFC-476 — the collaboration half of a terminal task deletion, required by task-execution's delete
// (`infrastructure/taskDelete.ts`) and implemented by collaboration's in-transaction deletion participant.
// task-execution owns this port (a consumer-owned SPI): it takes no collaboration import, and the
// composition root binds collaboration's implementation (the target DAG's offered edge is
// collaboration → task-execution).
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

/** Bound to the deletion transaction: the frozen audience snapshot and the FK-less feedback rows. */
export interface TaskDeletionCollaborationPort {
  members(
    taskIds: readonly string[],
  ): Promise<readonly { readonly taskId: string; readonly userId: string }[]>
  deleteFeedback(taskIds: readonly string[]): Promise<void>
}

/** Binds the collaboration half to the caller's transaction. */
export type TaskDeletionCollaborationInTx = (tx: PersistenceTx) => TaskDeletionCollaborationPort
