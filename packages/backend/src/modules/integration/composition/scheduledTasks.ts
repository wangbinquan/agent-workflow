import type { Config } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import { validateAgentLaunchShape } from '@/modules/task-execution/public/queries'
import {
  assertTriggerPreflight,
  assertWorkflowLaunchInputs,
} from '@/modules/resource-catalog/public/queries'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntegrationTriggerSnapshotFactory } from '../application/ports/integrationTriggerSnapshots'
import type {
  IntegrationTriggerValidationRuntime,
  ScheduleAuthorityRuntime,
  ScheduledTaskOperations,
  ScheduledTaskRuntime,
} from '../application/scheduledTasks'
import { runDueSchedulesOnce, SCHEDULE_MAX_IN_FLIGHT } from '../application/scheduledTaskScheduler'
import type { IntegrationTriggerResourceQueries } from '../application/ports/scheduledTaskPersistence'
import type { BuildScheduleLaunch } from '../application/ports/scheduledLaunch'
import { createIntegrationTriggerResources } from '../infrastructure/integrationTriggerResources'
import { createScheduledTaskPersistence } from '../infrastructure/scheduledTaskPersistence'

export type {
  BuildScheduleLaunch,
  IntegrationTriggerResourceQueries,
  ScheduleAuthorityRuntime,
  ScheduledTaskRuntime,
}

export function composeScheduledTaskRuntime(input: {
  readonly persistence: ScheduledTaskOperations['persistence']
  readonly integrationTriggerResources: IntegrationTriggerResourceQueries
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}): ScheduledTaskRuntime {
  return Object.freeze({
    operations: Object.freeze({
      persistence: input.persistence,
      // RFC-438：三条 legacy 校验在这里补进 operations（application 不直接 import 它们），调用顺序不变。
      validation: Object.freeze({
        assertWorkflowLaunchable: (
          workflow: Parameters<IntegrationTriggerValidationRuntime['assertWorkflowLaunchable']>[0],
        ) => input.validation.assertWorkflowLaunchable(workflow),
        assertAgentIntegrity: (agentIds: readonly string[]) =>
          input.validation.assertAgentIntegrity(agentIds),
        assertTriggerPreflight,
        assertWorkflowLaunchInputs: (
          defs: Parameters<typeof assertWorkflowLaunchInputs>[0],
          inputs: Parameters<typeof assertWorkflowLaunchInputs>[1],
        ) => assertWorkflowLaunchInputs(defs, inputs),
        async validateAgentLaunchShape(...args: Parameters<typeof validateAgentLaunchShape>) {
          // RFC-477：校验迁进 task-execution domain、经它的 public 取。原来惰性加载的是整个 legacy 服务文件；现在是一个
          // 纯函数、所在模块启动时就已加载，改为具名静态 import（对整份 public 入口的动态 import 会被计成用到了它的
          // 全部符号）。接口仍是 async，调用方不变。
          validateAgentLaunchShape(...args)
        },
      }),
      resourceAclChanged: input.resourceAclChanged,
      notifications: Object.freeze({
        notify: (change: Parameters<ScheduledTaskOperations['notifications']['notify']>[0]) =>
          scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, change),
      }),
    }),
    integrationTriggerResources: input.integrationTriggerResources,
    overview: Object.freeze({
      countScheduled(actor: Actor) {
        return actor.permissions.has('scheduled-tasks:read')
          ? input.persistence.countVisible(actor)
          : Promise.resolve(null)
      },
    }),
  })
}

export interface ScheduledTaskRuntimeInput {
  readonly db: PersistenceDb
  readonly resourceSnapshots: IntegrationTriggerSnapshotFactory
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}

/**
 * RFC-359 W4-D1：两个 provider 装同一份——Integration 持有事务、装入 Resource Catalog 的快照工厂与自己的
 * 数字员工参与者；持久化与资源查询都是 provider 中立实现。
 */
export function composeScheduledTaskRuntimeFor(
  input: ScheduledTaskRuntimeInput,
): ScheduledTaskRuntime {
  const resources = createIntegrationTriggerResources(input.db, input.resourceSnapshots)
  return composeScheduledTaskRuntime({
    persistence: createScheduledTaskPersistence(input.db, resources),
    integrationTriggerResources: resources,
    validation: input.validation,
    resourceAclChanged: input.resourceAclChanged,
  })
}

/**
 * RFC-438：定时任务的「跑一轮」。task-execution 的后台循环持有节奏与开关，每拍调用这里的 `runDue`；
 * 与原先 task-execution composition 里的闭包逐字等价（限额 `SCHEDULE_MAX_IN_FLIGHT`、失败上限与默认 runtime 取自本拍配置）。
 */
export function composeScheduledTaskRunner(input: {
  readonly operations: ScheduledTaskOperations
  readonly identityAccess: ScheduleAuthorityRuntime
  readonly buildLaunch: BuildScheduleLaunch
  readonly onAutoDisable?: (id: string) => void
}) {
  return Object.freeze({
    async runDue(due: {
      readonly maxFailures: Config['scheduledTasksMaxFailures']
      readonly defaultRuntime: Config['defaultRuntime']
    }): Promise<void> {
      await runDueSchedulesOnce(input.operations, {
        buildLaunch: input.buildLaunch,
        identityAccess: input.identityAccess,
        maxFailures: due.maxFailures,
        limit: SCHEDULE_MAX_IN_FLIGHT,
        defaultRuntime: due.defaultRuntime,
        ...(input.onAutoDisable === undefined ? {} : { onAutoDisable: input.onAutoDisable }),
      })
    },
  })
}
