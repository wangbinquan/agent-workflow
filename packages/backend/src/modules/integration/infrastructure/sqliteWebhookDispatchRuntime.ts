import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { ScheduledTaskOperations } from '@/services/scheduledTasks'
import {
  createWebhookExecutionRuntime,
  type WebhookExecutionRuntimeDependencies,
} from './webhookExecutionRuntime'
import type { DigitalEmployeeWorkStartPort } from '../public/participants'
import { composeWebhookLaunchAdmission } from '../composition/webhookAdmission'

export function createSqliteWebhookLaunchAdmission(
  operations: ScheduledTaskOperations,
): WebhookDispatchDeps['admitLaunch'] {
  return composeWebhookLaunchAdmission(operations)
}

type SqliteWebhookExecutionRuntimeInput = Readonly<{
  readonly taskExecutions: WebhookExecutionRuntimeDependencies['taskExecutions']
}>

/** Full SQLite composition; the selected TaskExecution participant is required. */
export function createSqliteWebhookExecutionRuntime(
  input: SqliteWebhookExecutionRuntimeInput & {
    readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
  },
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: input.digitalEmployeeWorkStart,
  })
}

/** SQLite embedding surface for dispatchers that intentionally exclude Digital Employee targets. */
export function createSqliteWebhookOrchestrationRuntime(
  input: SqliteWebhookExecutionRuntimeInput,
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: null,
  })
}
