import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import {
  createWebhookExecutionRuntime,
  type WebhookExecutionRuntimeDependencies,
} from './webhookExecutionRuntime'
import type { DigitalEmployeeWorkStartPort } from '../public/participants'

type PostgresqlWebhookExecutionRuntimeInput = Readonly<{
  readonly taskExecutions: WebhookExecutionRuntimeDependencies['taskExecutions']
}>

/** Full PostgreSQL composition. No SQLite client, alias, or fallback is accepted. */
export function createPostgresqlWebhookExecutionRuntime(
  input: PostgresqlWebhookExecutionRuntimeInput & {
    readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
  },
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: input.digitalEmployeeWorkStart,
  })
}

/** PostgreSQL embedding surface for orchestration-only dispatchers. */
export function createPostgresqlWebhookOrchestrationRuntime(
  input: PostgresqlWebhookExecutionRuntimeInput,
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return createWebhookExecutionRuntime({
    taskExecutions: input.taskExecutions,
    digitalEmployeeWorkStart: null,
  })
}
