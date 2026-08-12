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
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
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
export function buildScheduleLaunch(db: DbClient, configPath: string): BuildScheduleLaunch {
  return (ownerUserId, scheduledTaskId) => async (kind, payload, actor: Actor) => {
    const deps = {
      ...buildStartTaskDeps(db, configPath, ownerUserId, undefined),
      // RFC-243 实现门 P0-1: scheduled fires resolve call-node closures inside
      // the rebuilt owner actor's visibility (same fence as a manual launch).
      launchActor: actor,
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
