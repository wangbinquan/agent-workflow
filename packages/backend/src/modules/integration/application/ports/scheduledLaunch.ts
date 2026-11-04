// RFC-438 — 定时任务消费的启动端口（consumer-owned）。实现是 task-execution 的启动闭包（它启动的是本域任务），
// 由 bootstrap 连接；两边的类型结构同形，task-execution 的 public 面因此不必携带 legacy `Actor` 与函数类型。
import type { ScheduledLaunchKind } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { TaskExecutionResourceBinding } from '@/modules/task-execution/public/commands'

/**
 * RFC-165 §9b: the launch closure dispatches by launch kind. `payload` is
 * the kind-enveloped body ALREADY validated via scheduledPayloadSchemaFor;
 * `actor` is the owner actor fireSchedule rebuilt (agent/workgroup launches
 * run their own ACL gates against it).
 */
export type ScheduleLaunch = (
  kind: ScheduledLaunchKind,
  payload: Record<string, unknown>,
  actor: Actor,
  resources: Readonly<{
    readonly authority: ResourceRequestContext
    readonly actor: Actor
    readonly resources: TaskExecutionResourceBinding
  }>,
) => Promise<{ id: string }>
export type BuildScheduleLaunch = (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch
