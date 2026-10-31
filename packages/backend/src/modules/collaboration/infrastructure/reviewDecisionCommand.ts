import type { TaskExecutionParticipantBindings } from './taskExecutionParticipantBindings'
import type { CollaborationTaskRolePolicy } from '../application/ports/collaborationTaskRolePolicy'
import type { HumanGateTaskLockPort, ReviewUpstreamAgentPort } from '../composition/required-ports'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { ContentStore } from '@/platform/content/contentStore'
import type { ReviewArtifactSelection } from '../application/ports/reviewArtifactSelection'
import type { WorkspaceRollbackSnapshotInspector } from '../application/prepareWorkspaceRollbackPlan'
import { DatabaseCommittedReviewArtifactReader } from './committedReviewArtifactReader'
import { createFileReviewArtifactContent } from './local/fileReviewArtifactContent'
// RFC-359 W1-T2c（F-H2-1 之三）—— collaboration 的评审决定命令端口：一份实现，两个引擎。
//
// 此前只有 `createSqliteReviewDecisionCommand`（`legacySqliteReviewDecisionComposition.ts`），
// PostgreSQL daemon 从未注入 `reviewDecisions`，路由一到就 500；决定事务体
// （`review.ts#submitReviewDecisionUnlocked`）现在跑在 `DatabaseSession` 上，
// 评论 / 选择 / 决定的五个事务体两个 provider 共用。
//
// 保留动态 import：命令端口在 bootstrap 装配，业务实现仍在调用时才载入。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskActorRole } from '@agent-workflow/shared'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { ReviewDecisionCommandPort } from '@/modules/collaboration/application/ports/reviewDecisionCommand'
import { createCollaborationCommandContext } from './collaborationCommandContext'

export function createReviewDecisionCommand(input: {
  readonly taskExecutionParticipants: TaskExecutionParticipantBindings
  readonly taskRolePolicy: CollaborationTaskRolePolicy
  readonly taskLock: HumanGateTaskLockPort
  readonly historyRestrictions: HistoryRestrictionPort
  readonly content?: ContentStore
  readonly upstreamAgents: ReviewUpstreamAgentPort
  readonly db: PersistenceDb
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly rollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly appHome: string
}): ReviewDecisionCommandPort {
  return {
    async submit(command) {
      const { submitReviewDecision } = await import('./review')
      const decided = await submitReviewDecision({
        taskExecutionParticipants: input.taskExecutionParticipants,
        db: input.db,
        taskRolePolicy: input.taskRolePolicy,
        taskLock: input.taskLock,
        historyRestrictions: input.historyRestrictions,
        upstreamAgents: input.upstreamAgents,
        reviewReader:
          input.reviewArtifacts || input.content
            ? new DatabaseCommittedReviewArtifactReader(
                input.db,
                input.reviewArtifacts?.content ?? createFileReviewArtifactContent(input.appHome),
                input.content,
              )
            : undefined,
        rollbackSnapshots: input.rollbackSnapshots,
        appHome: input.appHome,
        nodeRunId: command.nodeRunId,
        decision: command.decision,
        expectedReviewIteration: command.expectedReviewIteration,
        author: command.actor.user.id,
        authorRole: command.authorRole,
        actor: command.actor,
        ...(command.rejectReason === undefined ? {} : { rejectReason: command.rejectReason }),
        ...(command.expectedTaskRevision === undefined
          ? {}
          : { expectedTaskRevision: command.expectedTaskRevision }),
        ...(command.expectedGateRevision === undefined
          ? {}
          : { expectedGateRevision: command.expectedGateRevision }),
        ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
        ...(command.comments === undefined ? {} : { comments: command.comments }),
        ...(command.selections === undefined ? {} : { selections: command.selections }),
      })
      return {
        taskId: decided.taskId,
        reviewIteration: decided.reviewIteration,
        receipt: decided.receipt,
        commentsAdded: decided.batch?.commentsAdded ?? 0,
        commentsSkippedAsDuplicate: decided.batch?.commentsSkippedAsDuplicate ?? 0,
        selectionsApplied: decided.batch?.selectionsApplied ?? 0,
      }
    },
  }
}

/** Legacy test bridge; production routes use the bootstrap-owned context. */
export function createReviewDecisionCommandContext(input: {
  readonly taskExecutionParticipants: TaskExecutionParticipantBindings
  readonly taskRolePolicy: CollaborationTaskRolePolicy
  readonly taskLock: HumanGateTaskLockPort
  readonly historyRestrictions: HistoryRestrictionPort
  readonly content?: ContentStore
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly upstreamAgents: ReviewUpstreamAgentPort
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly authorRole: TaskActorRole
}): CollaborationCommandContext<'reviewDecisions'> {
  return createCollaborationCommandContext({
    taskRolePolicy: input.taskRolePolicy,
    taskLock: input.taskLock,
    historyRestrictions: input.historyRestrictions,
    content: input.content,
    reviewArtifacts: input.reviewArtifacts,
    db: input.db,
    appHome: input.appHome,
    reviewDecisions: createReviewDecisionCommand({
      taskExecutionParticipants: input.taskExecutionParticipants,
      db: input.db,
      appHome: input.appHome,
      taskRolePolicy: input.taskRolePolicy,
      taskLock: input.taskLock,
      historyRestrictions: input.historyRestrictions,
      content: input.content,
      reviewArtifacts: input.reviewArtifacts,
      upstreamAgents: input.upstreamAgents,
    }),
  })
}
