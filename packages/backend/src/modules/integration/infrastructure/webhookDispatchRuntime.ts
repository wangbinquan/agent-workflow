// RFC-359 W4-B4 —— webhook 派发的执行运行时装配：一份实现，两个 provider 共用。
// 执行器调用面（RFC-257 / RFC-243 源码锁点名的文件）：只经注入的 TaskExecution 参与者启动 / 取消。

import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { ScheduledTaskOperations } from '@/services/scheduledTasks'
import {
  createWebhookExecutionRuntime,
  type WebhookExecutionRuntimeDependencies,
} from './webhookExecutionRuntime'
import type { DigitalEmployeeWorkStartPort } from '../public/participants'
import { composeWebhookLaunchAdmission } from '../composition/webhookAdmission'

export function createWebhookLaunchAdmission(
  operations: ScheduledTaskOperations,
): WebhookDispatchDeps['admitLaunch'] {
  return composeWebhookLaunchAdmission(operations)
}

type WebhookDispatchRuntimeInput = Readonly<{
  readonly taskExecutions: WebhookExecutionRuntimeDependencies['taskExecutions']
}>

/** 完整装配：选定的 TaskExecution 参与者与数字员工 work-start 端口都必填。 */
export function createWebhookDispatchExecutionRuntime(
  input: WebhookDispatchRuntimeInput & {
    readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
  },
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: input.digitalEmployeeWorkStart,
  })
}

/** 只做编排的嵌入面：有意排除数字员工目标。 */
export function createWebhookDispatchOrchestrationRuntime(
  input: WebhookDispatchRuntimeInput,
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: null,
  })
}
