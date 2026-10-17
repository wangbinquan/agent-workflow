// RFC-370 v3 V8 — the one audit outcome of a verified code-host delivery once
// its observations are published, shared by every transport (direct webhook
// and CrewStation event delivery) so the two can never disagree.
import type { WebhookDeliveryReason } from '@agent-workflow/shared'

export type WebhookDeliveryOutcome = Readonly<{
  status: 'matched' | 'ignored'
  reason?: Extract<WebhookDeliveryReason, 'terminal-control-accepted' | 'no-trigger-matched'>
}>

/**
 * Matched when an observation reached a subscriber, or when the delivery's
 * MR/PR terminal control was accepted even without one; otherwise ignored.
 */
export function webhookDeliveryOutcome(input: {
  readonly deliveryCount: number
  readonly effectId: string | null
}): WebhookDeliveryOutcome {
  if (input.deliveryCount > 0) return { status: 'matched' }
  if (input.effectId !== null) return { status: 'matched', reason: 'terminal-control-accepted' }
  return { status: 'ignored', reason: 'no-trigger-matched' }
}
