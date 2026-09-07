import type { ReviewNodeReviewerDependencies } from '../application/reviewNodeReviewers'
import {
  requireCollaborationTaskExecutionReadModels,
  resolveCollaborationCommandContext,
} from './commandContext'
import type { CollaborationCommandContext } from '../public/types'

export function reviewNodeReviewerDependencies(
  context: CollaborationCommandContext,
): ReviewNodeReviewerDependencies {
  // RFC-359 W5-T19b：`reviewTaskAccess` 是组合根的必填字段，这里直接读。
  // 此前这个文件私藏了一份 `createReviewTaskAccessPort(context)`——与 `commandContext.ts` 的
  // `requireReviewTaskAccess` 逐字同构，只是抛的话术不同（`collaboration review task access is
  // not composed` vs `collaboration task access is not composed`）。同一个缺口两处兜底、两种
  // 错误文案，正是「装配槽可为空」派生出来的重复。
  const dependencies = resolveCollaborationCommandContext(context)
  return {
    reviewerStore: dependencies.persistence.reviewers,
    taskAccess: dependencies.reviewTaskAccess,
    taskExecutionReadModels: requireCollaborationTaskExecutionReadModels(context),
  }
}
