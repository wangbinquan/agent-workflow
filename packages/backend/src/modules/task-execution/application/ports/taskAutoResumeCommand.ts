import type { TaskRecoveryBreakerConfig } from './taskRecoveryOperations'

/**
 * 「谁发起了这次重试」。**必须由调用方交进来**（2026-09-19）：
 *
 * 重试仓库准备要提交一条 `retry-repository-preparation` 续跑，而
 * `taskContinuationAdmission` 对「留着 `requires-actor` 重放决定」的血缘只接受**演员命令**
 * （`mayAuthorizeReplay`：`source ∈ {rest, mcp}` 且带 actorUserId 且 kind 在
 * `ACTOR_REPLAY_COMMANDS` 里）。此前这条命令一律以 `source: 'auto'` / `actorUserId: null`
 * 提交，于是用户在任务页点「重试准备」拿到的是
 * `task-execution-outcome-unknown: … use a manual resume/retry/sync command`
 * ——而他刚刚用的**就是**那条手动命令：卡在仓库准备的任务从界面上永远重试不了（e2e TASK-27）。
 *
 * 缺席 = boot 自动恢复那条路（它确实是 `auto`，也确实不该授权重放）。
 */
export interface RepositoryPreparationRetryAuthorization {
  readonly actorUserId: string
}

export interface RepositoryPreparationRetryCommand {
  retry(taskId: string, authorization?: RepositoryPreparationRetryAuthorization): Promise<void>
}

export interface TaskAutoResumeResult {
  readonly resumed: readonly string[]
  readonly skipped: readonly string[]
}

/** Closed boot recovery command; repository preparation retry is required. */
export interface TaskAutoResumeCommand {
  run(input: { readonly breaker: TaskRecoveryBreakerConfig }): Promise<TaskAutoResumeResult>
}
