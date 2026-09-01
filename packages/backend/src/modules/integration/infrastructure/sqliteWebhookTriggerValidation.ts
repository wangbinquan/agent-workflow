import type { Actor } from '@/auth/actor'
import type {
  IntegrationTriggerResourceAuthority,
  ScheduledTaskOperations,
} from '@/services/scheduledTasks'
import type { WebhookTriggerSaveCandidate } from '@/services/webhook/triggerValidation'
import type { WebhookTriggerServiceDeps } from '@/services/webhookTriggers'
import {
  assertWebhookTriggerSaveable,
  composeWebhookTriggerValidation,
} from '../composition/webhookAdmission'

export async function assertSqliteWebhookTriggerSaveable(
  operations: ScheduledTaskOperations,
  actor: Actor,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  candidate: WebhookTriggerSaveCandidate,
  defaultRuntime: string | null | undefined,
): Promise<void> {
  await assertWebhookTriggerSaveable(
    operations,
    actor,
    resourceAuthority,
    candidate,
    defaultRuntime,
  )
}

export function createSqliteWebhookTriggerValidation(
  operations: ScheduledTaskOperations,
  configPath: string,
): WebhookTriggerServiceDeps['validateSaveable'] {
  return composeWebhookTriggerValidation(operations, configPath)
}
