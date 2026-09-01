import type { NodeRunLifecycleParticipantInTx } from '../public/commands'
import { createPostgresqlNodeRunLifecycleParticipantInTx } from '../infrastructure/postgresqlNodeRunLifecyclePersistence'
import type { PostgresqlTaskExecutionTransaction } from '../infrastructure/postgresqlTaskLifecycleTransaction'

export interface PostgresqlNodeRunLifecycleParticipantFactory {
  inTransaction(transaction: PostgresqlTaskExecutionTransaction): NodeRunLifecycleParticipantInTx
}

/** TaskExecution composition seam for Collaboration-owned serializable atoms. */
export function composePostgresqlNodeRunLifecycleParticipantFactory(): PostgresqlNodeRunLifecycleParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: PostgresqlTaskExecutionTransaction) =>
      createPostgresqlNodeRunLifecycleParticipantInTx(transaction),
  })
}
