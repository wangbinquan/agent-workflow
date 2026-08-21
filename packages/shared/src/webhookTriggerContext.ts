// RFC-292 — trusted normalized-webhook-event -> frozen task context adapter.

import type { CodeHostEvent } from './schemas/webhook'
import {
  createTriggerContext,
  type TriggerContext,
  type WebhookTriggerFields,
} from './triggerContext'
import { WEBHOOK_EVENT_VAR_MATRIX } from './schemas/webhook'
import { eventVarsOf } from './webhookTemplate'

/** Project only the exact Event Type contract, retaining event_type as discriminator. */
export function webhookTriggerContextOf(event: CodeHostEvent): TriggerContext {
  const all = eventVarsOf(event)
  const availableFields = WEBHOOK_EVENT_VAR_MATRIX[event.eventType]
  const webhook: Record<string, string> = { event_type: event.eventType }
  for (const field of availableFields) {
    if (field === 'event_type') continue
    const value = all[field]
    // Missing and present-empty have identical render semantics. Omitting empty
    // optional keys keeps the task snapshot compact without weakening shape.
    if (value.length > 0) webhook[field] = value
  }
  return createTriggerContext({
    namespace: 'webhook',
    definitionRef: { id: `code-host.webhook.${event.eventType}`, revision: 1 },
    availableFields,
    values: webhook as WebhookTriggerFields,
  })
}
