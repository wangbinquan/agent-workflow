import type { TaskRollbackCheckpointRun } from '@/modules/task-execution/public/types'
import type { WorkspaceRollbackCandidateTarget } from '../../domain/workspaceRollbackPlan'

// RFC-477 —— collaboration 自有的节点回滚端口（consumer 拥有 required SPI，RFC-294 design §3.3）。
//
// 评审决策的回滚规划（`review.ts` 的 `planRerun` → `prepareWorkspaceRollbackPlan`）与反问自动派发的自回滚
// （`clarify/autoDispatch.ts`）此前直接调 legacy 的 `services/nodeRollback.ts`；回滚迁进 task-execution 后，
// collaboration 经这个端口取，由 bootstrap 交 task-execution 的实现（`TaskExecutionParticipantBindings`）。
// 目标里的数据库句柄与 RFC-328 effect 记账留在 task-execution，这里只看见按任务装载的作用域。

/** 回滚只记 warn（逐仓失败、逐仓映射解析失败）。 */
export interface NodeRunWorkspaceRollbackLog {
  warn(msg: string, fields?: Record<string, unknown>): void
}

/** 逐仓结果：`attempted` 表示至少回滚了一个工作树；`failures` 是逐仓失败（warn-and-continue）。 */
export interface NodeRunWorkspaceRollbackOutcome {
  readonly attempted: boolean
  readonly failures: ReadonlyArray<{
    readonly worktreeDirName?: string
    readonly code: string
    readonly message: string
  }>
}

/** 一个任务的节点回滚作用域：目标装载一次，规划与执行都对着它。 */
export interface NodeRunWorkspaceRollbackScope {
  /** 只规划、不碰工作区：这一轮检查点要回到的工作树 / 快照对。 */
  plan(run: TaskRollbackCheckpointRun): readonly WorkspaceRollbackCandidateTarget[]
  /** 执行回滚：逐仓 warn-and-continue，结果里带失败明细。 */
  rollback(
    run: TaskRollbackCheckpointRun,
    log: NodeRunWorkspaceRollbackLog,
  ): Promise<NodeRunWorkspaceRollbackOutcome>
}

export interface NodeRunWorkspaceRollbackPort {
  /** 任务不在（或没有工作区记录）时为 null。 */
  load(taskId: string): Promise<NodeRunWorkspaceRollbackScope | null>
}
