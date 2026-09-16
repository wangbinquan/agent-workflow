import {
  ScheduledAgentPayloadSchema,
  ScheduledWorkgroupPayloadSchema,
  StartTaskSchema,
} from '@agent-workflow/shared'

import type { WebhookTaskExecutionParticipant } from '@/modules/integration/application/ports/webhookExecution'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { ExecutionInvoker, TaskCancellationCommand } from '../public/commands'
import type { PostgresqlTaskExecutionLaunchParticipant } from '../infrastructure/postgresqlTaskRouteLaunchOperations'

export type TaskExecutionTriggerParticipant = WebhookTaskExecutionParticipant<
  TaskExecutionResourceAuthority,
  ExecutionInvoker
>

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①②）—— 触发器参与者，**两个引擎唯一的一份**。
 *
 * 合一前一对孪生，差别整个在「谁来启动」：PostgreSQL 那半是这八行转发，SQLite 那半自己调
 * `services/execution/executor.ts#startExecution`——而那正是**启动参与者的第二份写法**
 *（同一个 workflow / agent / workgroup 三分支 switch，只是终端转 `startTask` /
 * `startAgentTask` / `startWorkgroupTask`）。SQLite 一有启动参与者，这一对就塌成一份，
 * 不需要额外设计。
 *
 * 顺带一处**真行为补齐**：旧的 SQLite 那半只在进门 `await guard?.verifyCanCommit()`，
 * 然后**把 guard 丢掉**——于是受保护 MR 的 webhook 启动在 SQLite 上既没有
 * `assertProtectedLaunchGuard` 的快照一致性检查，也拿不到 `sourceTerminationLaunchSignal`
 *（MR 中途关闭时那次克隆不会被打断）。现在两侧都把 guard 原样交给启动内核。
 */
export function createTaskExecutionTriggerParticipant(input: {
  readonly launches: PostgresqlTaskExecutionLaunchParticipant
  readonly cancellation: TaskCancellationCommand
}): TaskExecutionTriggerParticipant {
  return Object.freeze({
    async launch(request: Parameters<TaskExecutionTriggerParticipant['launch']>[0]) {
      const task = await input.launches.launch(request)
      return { taskId: task.id }
    },
    async cancel(taskId: string) {
      await input.cancellation.cancel({ taskId, cause: { kind: 'user' } })
    },
  })
}

/** ScheduledTask's launch closure over the selected provider participant. */
export function createBuildScheduleLaunch(
  participant: TaskExecutionTriggerParticipant,
): BuildScheduleLaunch {
  return (_ownerUserId: string, scheduledTaskId: string) =>
    async (kind, payload, actor, resources) => {
      const invoker = Object.freeze({ type: 'scheduled', scheduledTaskId } as const)
      if (kind === 'agent') {
        const parsed = ScheduledAgentPayloadSchema.parse(payload)
        const receipt = await participant.launch({
          actor,
          target: { kind, refId: parsed.agentId, payload: parsed },
          invoker,
          resources,
        })
        return { id: receipt.taskId }
      }
      if (kind === 'workgroup') {
        const parsed = ScheduledWorkgroupPayloadSchema.parse(payload)
        const receipt = await participant.launch({
          actor,
          target: { kind, refId: parsed.workgroupId, payload: parsed },
          invoker,
          resources,
        })
        return { id: receipt.taskId }
      }
      const parsed = StartTaskSchema.parse(payload)
      const receipt = await participant.launch({
        actor,
        target: { kind, refId: parsed.workflowId, payload: parsed },
        invoker,
        resources,
      })
      return { id: receipt.taskId }
    }
}
