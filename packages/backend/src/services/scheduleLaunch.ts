// RFC-159 — the launch closure shared by the scheduled-task loop (cli/start.ts)
// and the manual run-now route. Kept in its own tiny module so it can import
// startTask (a VALUE) without dragging services/task.ts into an import cycle:
// nothing that task.ts imports transitively reaches here.
//
// RFC-165 §9b: the closure dispatches by launch kind — workflow rows keep the
// direct startTask path; agent / workgroup rows go through their launch
// services (which re-run the full ACL / builtin / readiness gates against the
// owner actor rebuilt by fireSchedule).
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { startAgentTask } from '@/services/agentLaunch'
import { startTask } from '@/services/task'
import { startWorkgroupTask } from '@/services/workgroup/launch'
import { resolveOpencodeCmd } from '@/util/opencode'
import type {
  ScheduledAgentPayload,
  ScheduledWorkgroupPayload,
  StartTask,
} from '@agent-workflow/shared'

/**
 * `(ownerUserId, scheduledTaskId) => (kind, payload, actor) => …` — builds the
 * launch deps live (so scheduled / manual launches match a manual UI launch)
 * and stamps `tasks.scheduled_task_id` for run-history attribution.
 */
export function buildScheduleLaunch(db: DbClient, configPath: string): BuildScheduleLaunch {
  return (ownerUserId, scheduledTaskId) => async (kind, payload, actor: Actor) => {
    const deps = {
      ...buildStartTaskDeps(db, configPath, ownerUserId, resolveOpencodeCmd(configPath)),
      scheduledTaskId,
    }
    if (kind === 'agent') {
      const p = payload as unknown as ScheduledAgentPayload
      // RFC-223 PR-7: the durable envelope requires the canonical id. The
      // launch service resolves that id directly; the name snapshot is display
      // metadata only and can never become a fallback.
      const task = await startAgentTask(
        db,
        actor,
        p.agentId,
        { ...p, expectedAgentId: p.agentId },
        deps,
      )
      return { id: task.id }
    }
    if (kind === 'workgroup') {
      const p = payload as unknown as ScheduledWorkgroupPayload
      const task = await startWorkgroupTask(
        db,
        actor,
        p.workgroupId,
        { ...p, expectedWorkgroupId: p.workgroupId },
        deps,
      )
      return { id: task.id }
    }
    const task = await startTask(payload as unknown as StartTask, deps)
    return { id: task.id }
  }
}
