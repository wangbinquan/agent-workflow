// RFC-292 — trusted normalized-webhook-event -> frozen task context adapter.

import type { CodeHostEvent } from './schemas/webhook'
import type { TriggerContext, WebhookTriggerFields } from './triggerContext'
import { eventVarsOf } from './webhookTemplate'

/** Project all 30 canonical fields, retaining event_type as the discriminator. */
export function webhookTriggerContextOf(event: CodeHostEvent): TriggerContext {
  const all = eventVarsOf(event)
  const webhook: Record<string, string> = { event_type: event.eventType }
  for (const [field, value] of Object.entries(all)) {
    if (field === 'event_type') continue
    // Missing and present-empty have identical render semantics. Omitting empty
    // optional keys keeps the task snapshot compact without weakening shape.
    if (value.length > 0) webhook[field] = value
  }
  return {
    trigger: {
      webhook: webhook as WebhookTriggerFields,
    },
  }
}
