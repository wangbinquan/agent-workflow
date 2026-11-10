// RFC-478 —— 原 `services/task.ts` 的两个测试专用出口（生产零调用方），函数体原样迁来。
import { taskExecutionModule } from '@/modules/task-execution/composition'
import { isTaskDriverActive } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'

/** RFC-097 (audit S-8/S-23): is an in-process scheduler loop attached to this
 *  task right now? Used by resume/retry entry rejection and lifecycleRepair's
 *  scheduler-liveness preflight. */
export function isTaskActive(taskId: string): boolean {
  return isTaskDriverActive(taskId)
}

/**
 * P-4-06: abort every in-flight task. Used by daemon shutdown. The runner
 * SIGTERMs each opencode child via the controller's signal; the scheduler
 * then marks rows canceled/interrupted in the normal flow.
 *
 * RFC-202 T4: `reason` rides on the AbortController
 * (`controller.abort(reason)` → `signal.reason`) so the scheduler's abort
 * checkpoints can tell a daemon shutdown (→ interrupted + daemon-restart,
 * resumable) apart from a user cancel (no-arg abort → canceled by user).
 */
export function abortAllActiveTasks(reason: string): string[] {
  const tickets = taskExecutionModule.runtimeRegistry.abortAll(reason)
  return tickets.map((ticket) => ticket.token.taskId)
}
