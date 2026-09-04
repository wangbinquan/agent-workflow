// RFC-359 W1-T2c（F-H2-1 之三）—— collaboration 的评审决定命令端口：一份实现，两个引擎。
//
// 此前只有 `createSqliteReviewDecisionCommand`（`legacySqliteReviewDecisionComposition.ts`），
// PostgreSQL daemon 从未注入 `reviewDecisions`，路由一到就 500；决定事务体
// （`legacySqliteReview.ts#submitReviewDecisionUnlocked`）现在跑在 `DatabaseSession` 上，
// 评论 / 选择 / 决定的五个事务体两个 provider 共用。
//
// 保留动态 import：命令端口由 bootstrap 一次性组合，静态 import 评审域会经
// `services/humanGateComposition` 绕回 collaboration 的 composition barrel，形成值环。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskActorRole } from '@agent-workflow/shared'
import type {
  CollaborationCommandContext,
  ReviewDecisionCommandPort,
} from '@/modules/collaboration/public/types'
import { createCollaborationCommandContext } from '../composition/commandContext'

export function createReviewDecisionCommand(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
}): ReviewDecisionCommandPort {
  return {
    async submit(command) {
      const { submitReviewDecision } = await import('./legacySqliteReview')
      const decided = await submitReviewDecision({
        db: input.db,
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
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly authorRole: TaskActorRole
}): CollaborationCommandContext {
  return createCollaborationCommandContext({
    db: input.db,
    appHome: input.appHome,
    reviewDecisions: createReviewDecisionCommand({ db: input.db, appHome: input.appHome }),
  })
}
