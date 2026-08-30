// RFC-159 — the launch closure shared by the scheduled-task loop (cli/start.ts)
// and the manual run-now route. Kept in its own tiny module so it can import
// the executor (a VALUE) without dragging services/task.ts into an import
// cycle: nothing that task.ts imports transitively reaches here.
//
// RFC-165 §9b: the closure dispatches by launch kind — agent / workgroup rows
// re-run the full ACL / builtin / readiness gates against the owner actor
// rebuilt by fireSchedule. Workflow rows do NOT re-gate inside this closure,
// but they are not ungated: fireSchedule runs assertScheduledTargetUsable on
// every fire, whose workflow branch calls assertWorkflowLaunchable
// (services/scheduledTasks.ts, RFC-224 shared preflight; RFC-257 F-19 made
// webhook fires share the same check). Do not add a second gate here.
// (2026-08-12 审计对账：此注释原先断言「fire 时无 assertWorkflowLaunchable」，
// 与 fireSchedule 实际行为相反，已修正。)
// RFC-243 T2: all three kinds now go through the unified executor facade; the
// `scheduled` invoker stamps `tasks.scheduled_task_id` for run-history
// attribution (previously a hand-spread deps field).
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { StartTaskDeps } from '@/services/task'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { startExecution } from '@/services/execution/executor'
import type {
  ScheduledAgentPayload,
  ScheduledWorkgroupPayload,
  StartTask,
} from '@agent-workflow/shared'

/**
 * `(ownerUserId, scheduledTaskId) => (kind, payload, actor) => …` — builds the
 * launch deps live (so scheduled / manual launches match a manual UI launch)
 * and threads the `scheduled` invoker for run-history attribution.
 */
export function buildScheduleLaunch(
  db: DbClient,
  schedulerDriver: SchedulerDriverPort,
  configPath: string,
  identityAccess: NonNullable<StartTaskDeps['identityAccess']>,
): BuildScheduleLaunch {
  return (ownerUserId, scheduledTaskId) => async (kind, payload, actor: Actor) => {
    const deps = {
      ...buildStartTaskDeps(
        db,
        schedulerDriver,
        configPath,
        ownerUserId,
        undefined,
        identityAccess,
      ),
      // RFC-243 实现门 P0-1: scheduled fires resolve call-node closures inside
      // the rebuilt owner actor's visibility (same fence as a manual launch).
      launchActor: actor,
      // RFC-287 G7：定时/webhook 触发与手动启动**同一套语义**（proposal §G7 原话：
      // 「定时任务与 webhook 触发同一套语义」）。这里没有等 HTTP 响应的用户，但 G7
      // 的另一半收益恰恰是这两条最需要的：**准备失败要留下记录**。不开的话，一次
      // 拉不动远端的定时触发压根不铸任务行——用户在任务列表里什么都看不到，只能去
      // 翻触发历史里的一句错误，也没有任何可重试的对象（AC-11 的重试作用面为空）。
      deferRepoPreparation: true,
    }
    const invoker = { type: 'scheduled', scheduledTaskId } as const
    if (kind === 'agent') {
      const p = payload as unknown as ScheduledAgentPayload
      // RFC-223 PR-7: the durable envelope requires the canonical id. The
      // launch service resolves that id directly; the name snapshot is display
      // metadata only and can never become a fallback.
      const task = await startExecution(
        db,
        actor,
        {
          kind: 'agent',
          refId: p.agentId,
          invoker,
          payload: { ...p, expectedAgentId: p.agentId },
        },
        deps,
      )
      return { id: task.id }
    }
    if (kind === 'workgroup') {
      const p = payload as unknown as ScheduledWorkgroupPayload
      const task = await startExecution(
        db,
        actor,
        {
          kind: 'workgroup',
          refId: p.workgroupId,
          invoker,
          payload: { ...p, expectedWorkgroupId: p.workgroupId },
        },
        deps,
      )
      return { id: task.id }
    }
    const p = payload as unknown as StartTask
    const task = await startExecution(
      db,
      actor,
      { kind: 'workflow', refId: p.workflowId, invoker, payload: p },
      deps,
    )
    return { id: task.id }
  }
}
