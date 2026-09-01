import type { DbClient } from '@/db/client'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { eq } from 'drizzle-orm'
import { nodeRuns } from '@/db/schema'
import type {
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
} from '../application/ports/nodeRunLifecyclePersistence'
import { withTaskExecutionTransaction } from './sqliteOwnedTaskMutation'
import { createSqliteNodeRunMintParticipantInTx } from './sqliteNodeRunMintParticipant'

export class SqliteNodeRunLifecyclePersistence implements NodeRunLifecyclePersistence {
  constructor(private readonly db: DbClient) {}

  async mint(input: NodeRunMintInput): Promise<string> {
    const { executionContext, ...request } = input
    return withTaskExecutionTransaction({
      db: this.db,
      taskId: request.taskId,
      ...(executionContext === undefined ? {} : { context: executionContext }),
      run: (tx) => createSqliteNodeRunMintParticipantInTx(tx).mint(request),
    })
  }

  async transition(
    input: Parameters<NodeRunLifecyclePersistence['transition']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['transition']> {
    return await transitionNodeRunStatus({ db: this.db, ...input })
  }

  async set(
    input: Parameters<NodeRunLifecyclePersistence['set']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['set']> {
    return await setNodeRunStatus({ db: this.db, ...input })
  }

  async loadEnvelopeNonce(nodeRunId: string): Promise<string> {
    const rows = await this.db
      .select({ envelopeNonce: nodeRuns.envelopeNonce })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0]?.envelopeNonce ?? ''
  }
}
