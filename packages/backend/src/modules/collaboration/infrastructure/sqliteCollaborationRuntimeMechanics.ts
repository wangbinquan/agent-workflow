import type { DbClient } from '@/db/client'
import type { CollaborationRuntimeMechanics } from '../application/ports/collaborationRuntimeMechanics'
import {
  dismissSqliteOpenClarifyParksForAutonomous,
  isSqliteTaskClarifySuppressed,
} from './sqliteCollaborationWorkgroupClarify'

export function createSqliteCollaborationRuntimeMechanics(
  db: DbClient,
): CollaborationRuntimeMechanics {
  return Object.freeze({
    async dispatchReviewNode(input) {
      const { dispatchReviewNode } = await import('./legacySqliteReview')
      return dispatchReviewNode({ db, ...input })
    },
    async inspectCrossClarify(input) {
      const { dispatchCrossClarifyNode } = await import('./legacySqliteClarify/service')
      return dispatchCrossClarifyNode({ db, ...input })
    },
    async openAgentClarify(input) {
      const { createClarifyRound } = await import('./legacySqliteClarify/service')
      const common = {
        db,
        taskId: input.taskId,
        askingNodeId: input.askingNodeId,
        askingNodeRunId: input.askingNodeRunId,
        containerRunId: input.containerRunId ?? null,
        intermediaryNodeId: input.intermediaryNodeId,
        questions: [...input.questions],
        ...(input.truncationWarnings === undefined
          ? {}
          : { truncationWarnings: [...input.truncationWarnings] }),
      }
      const result =
        input.kind === 'self'
          ? await createClarifyRound({
              ...common,
              kind: 'self',
              askingShardKey: input.askingShardKey,
              iteration: input.iteration,
              ...(input.parentNodeRunId === undefined
                ? {}
                : { parentNodeRunId: input.parentNodeRunId }),
            })
          : await createClarifyRound({
              ...common,
              kind: 'cross',
              targetConsumerNodeId: input.targetConsumerNodeId,
              loopIter: input.loopIter,
            })
      return { intermediaryNodeRunId: result.intermediaryNodeRunId }
    },
    async resolveBorrowForNode(input) {
      const { resolveBorrowForNode } = await import('./legacySqliteTaskQuestionDispatch')
      return resolveBorrowForNode(db, input.taskId, input.nodeId, input.iteration, input.definition)
    },
    async buildReviewPromptContext(input) {
      const { buildReviewPromptContext } = await import('./legacySqliteReview')
      return buildReviewPromptContext(
        db,
        input.appHome,
        input.upstreamNodeId,
        input.taskId,
        input.iteration,
      )
    },
    async getNodeClarifyDirective(input) {
      const { getNodeClarifyDirective } = await import('./legacySqliteTaskClarifyDirective')
      return getNodeClarifyDirective(db, input.taskId, input.nodeId, input.shardKey)
    },
    async buildClarifyQueueContext(input) {
      const { buildClarifyQueueContext } = await import('./legacySqliteClarify/queue')
      return buildClarifyQueueContext({ db, ...input })
    },
    isTaskClarifySuppressed: (input) => isSqliteTaskClarifySuppressed(db, input),
    dismissOpenClarifyParksForAutonomous: (input) =>
      dismissSqliteOpenClarifyParksForAutonomous(db, input),
  } satisfies CollaborationRuntimeMechanics)
}
