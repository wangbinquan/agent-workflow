// RFC-438 — 定时启动闭包的本域合同：闭包把定时 payload 解析成本域的启动目标并调用本域参与者
// （infrastructure/taskExecutionTrigger.ts）。integration 声明结构同形的 consumer-owned 端口，bootstrap 连接；本合同不进 public
// （public 面不携带 legacy `Actor` 与函数类型），task-execution 也不认识定时任务的类型。
import type { ScheduledLaunchKind } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { TaskExecutionResourceBinding } from './taskExecutionResourceSnapshots'

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
