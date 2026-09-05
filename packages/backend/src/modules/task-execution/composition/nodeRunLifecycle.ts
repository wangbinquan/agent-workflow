import type { NodeRunLifecycleParticipantInTx } from '../public/commands'
import { createNodeRunLifecycleParticipantInTx } from '../infrastructure/nodeRunLifecyclePersistence'
import type { TaskExecutionTransaction } from '../infrastructure/ownedTaskExecution'

export interface PostgresqlNodeRunLifecycleParticipantFactory {
  inTransaction(transaction: TaskExecutionTransaction): NodeRunLifecycleParticipantInTx
}

/** TaskExecution composition seam for Collaboration-owned serializable atoms. */
export function composePostgresqlNodeRunLifecycleParticipantFactory(): PostgresqlNodeRunLifecycleParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: TaskExecutionTransaction) =>
      createNodeRunLifecycleParticipantInTx(transaction),
  })
}
