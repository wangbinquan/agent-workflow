// RFC-480 —— 评审节点评审人配置的读取与改写入口（原在 collaboration `public/queries.ts` / `public/commands.ts`，模块外零消费，
// 撤出 public）。依赖解析 `reviewNodeReviewerDependencies` 原在 `composition/reviewNodeReviewerDependencies.ts`：它只从命令上下文取出
// 已装配的端口（与 `commandContext.ts` 的 `require*` 同类），不构造任何实现，按内容（RFC-294 C10）归 application——task-execution 端口
// 适配器（`application/adapters/task-execution-adapter.ts`）因此可以取它而不越 application → composition 一层。
import type {
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
  ReviewSummary,
} from '@agent-workflow/shared'
import type { ReviewAccessDecision } from '../domain/reviewAccess'
import type { CollaborationCommandContext, ReviewActor } from '../public/types'
import {
  requireCollaborationTaskExecutionReadModels,
  resolveCollaborationCommandContext,
} from './commandContext'
import {
  filterReviewSummariesForActor as filterReviewSummariesForActorInternal,
  getReviewNodeReviewerConfig as getReviewNodeReviewerConfigInternal,
  replaceReviewNodeReviewers as replaceReviewNodeReviewersInternal,
  resolveReviewAccess as resolveReviewAccessInternal,
  type ReviewNodeReviewerDependencies,
} from './reviewNodeReviewers'

export function reviewNodeReviewerDependencies(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
): ReviewNodeReviewerDependencies {
  // RFC-359 W5-T19b：`reviewTaskAccess` 是组合根的必填字段，这里直接读。
  // 此前（还在 `composition/reviewNodeReviewerDependencies.ts` 时）这里私藏了一份 `createReviewTaskAccessPort(context)`——与 `commandContext.ts` 的
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

function reviewerDependencies(context: CollaborationCommandContext<'taskExecutionReadModels'>) {
  return reviewNodeReviewerDependencies(context)
}

export function getReviewNodeReviewerConfig(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<ReviewNodeReviewerConfig> {
  return getReviewNodeReviewerConfigInternal(
    reviewerDependencies(context),
    input.actor,
    input.taskId,
  )
}

export function resolveReviewAccess(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly nodeRunId: string },
): Promise<ReviewAccessDecision | null> {
  return resolveReviewAccessInternal(reviewerDependencies(context), input.actor, input.nodeRunId)
}

export function filterReviewSummariesForActor<T extends ReviewSummary>(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly rows: readonly T[] },
): Promise<Array<T & { accessScope: 'task' | 'review-node' }>> {
  return filterReviewSummariesForActorInternal(
    reviewerDependencies(context),
    input.actor,
    input.rows,
  )
}

export function replaceReviewNodeReviewers(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: {
    readonly actor: ReviewActor
    readonly taskId: string
    readonly body: ReplaceReviewNodeReviewersBody
  },
): Promise<ReviewNodeReviewerConfig> {
  return replaceReviewNodeReviewersInternal(
    reviewNodeReviewerDependencies(context),
    input.actor,
    input.taskId,
    input.body,
  )
}
