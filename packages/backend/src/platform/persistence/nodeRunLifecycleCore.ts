// RFC-359 W8 —— node_run 状态转移的**共享内核**：判据、错误类型、可随状态一起写的字段白名单。
// provider 无关、零向上依赖，是这条链上的叶子。
//
// 为什么要单独一层：`node_run` 的 CAS 现在有两份实现——
//   · `platform/persistence/sqlite/taskLifecycle.ts` 的**同步**版（`DbTxSync`，bun:sqlite 独有，
//     仍被 `cancelOpenNodeRunsTx` 与 `services/task.ts` 的同步事务体直调，本波不退役）；
//   · `modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts` 的**中立异步孪生**
//     （两个引擎共用）。
// 两份共用同一张转移表、同一个 MR/PR 围栏判据、同一个终态覆写闸——这三个符号就是那份共用面。
//
// 它们此前住在 `taskLifecycle.ts` 里，中立孪生经 `@/services/lifecycle` 这个 re-export facade
// 反向取用。那条边本身无环，但它**挡住了反方向**：`taskLifecycle.ts` 只要 import 中立孪生，就闭出
//   taskLifecycle → nodeRunLifecycleTransition → services/lifecycle → taskLifecycle
// 于是 `taskLifecycle.ts` 里那几处同步事务一直没法转成中立异步形态。把共用面下沉到这里之后，
// 两份实现都**向下**依赖本文件，反向边消失，同步事务面才迈得动（W8：该文件 4 → 2 处）。
//
// ⚠️ 本文件必须保持叶子：只许依赖 `@agent-workflow/shared` / `@/db/schema` 的类型 / `@/util/errors`。
// 往这里加任何指向 services/ 或 modules/ 的 import 都会把上面那条环装回来。

import type { NodeRunStatus } from '@agent-workflow/shared'

import type { nodeRuns } from '@/db/schema'
import { ConflictError } from '@/util/errors'

const SOURCE_TERMINATION_BLOCKED_NODE_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
])

/**
 * RFC-303 admission under a source-termination fence. RFC-326 exports it so the
 * review decision's pre-check (before any worktree rollback) and the transactional
 * helpers apply ONE predicate instead of two copies that could drift.
 */
export function assertNodeRunSourceTerminationAdmission(
  taskId: string,
  fence: 'closed' | 'merged' | null,
  to: NodeRunStatus,
): void {
  if (fence === null || !SOURCE_TERMINATION_BLOCKED_NODE_STATUSES.has(to)) return
  throw new ConflictError(
    fence === 'closed' ? 'task-source-terminal-closed' : 'task-source-terminal-merged',
    `task ${taskId} is fenced by an MR/PR ${fence} event; cannot move a node run to ${to}`,
  )
}

/**
 * Extra fields that may be written alongside a status transition (mirrors
 * common drizzle .set({}) shapes — runner pid/finishedAt/error, scheduler
 * preSnapshot, review reviewIteration/clarifyIteration, etc.). Whitelisted
 * here so callers can't smuggle `status` through this path.
 */
export type NodeRunStatusUpdateExtra = Partial<
  Pick<
    typeof nodeRuns.$inferInsert,
    | 'finishedAt'
    | 'startedAt'
    | 'errorMessage'
    // RFC-145: the structured failure companions ride the same atomic write as
    // status + errorMessage (runner-exit stamps failureCode; the review
    // supersede path stamps supersededByReview/rolledBack).
    | 'failureCode'
    | 'supersededByReview'
    | 'rolledBack'
    | 'exitCode'
    | 'pid'
    | 'reviewIteration'
    | 'consumedUpstreamRunsJson'
    | 'preSnapshot'
    | 'opencodeSessionId'
    | 'tokInput'
    | 'tokOutput'
    | 'tokCacheCreate'
    | 'tokCacheRead'
    | 'tokTotal'
  >
>

/**
 * Raised when CAS UPDATE affected 0 rows — the row's status is no longer
 * the value we read a moment ago (someone else wrote it concurrently), or
 * the row was deleted. Mapped to HTTP 409 by `util/errors`.
 */
export class ConcurrentNodeRunTransition extends ConflictError {
  constructor(nodeRunId: string, expectedFrom: NodeRunStatus, eventKind: string) {
    super(
      'concurrent-node-run-transition',
      `node_run ${nodeRunId} status changed concurrently (expected '${expectedFrom}', event '${eventKind}')`,
    )
  }
}
