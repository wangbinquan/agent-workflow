// RFC-300 — admission policy for immediate cleanup of direct Webhook task
// workspaces. This module deliberately owns only the integration attribution
// rule. Lifecycle owns the atomic status+claim write and GC/source-control owns
// physical deletion.

import type { SpaceKind, TaskStatus } from '@agent-workflow/shared'

export interface WebhookTerminalWorkspacePolicyInput {
  to: TaskStatus
  webhookTriggerId: string | null
  /** RFC-310 generic Event Center attribution; absent on pre-migration callers. */
  eventSubscriptionId?: string | null
  spaceKind: SpaceKind
  workspacePruningAt: number | null
  workspacePruneCause: 'webhook-terminal' | null
  workspacePrunedAt: number | null
}

/**
 * Exact RFC-300 candidate predicate. `triggerContextJson` is intentionally not
 * accepted: child call tasks inherit that context but do not own their parent
 * call-node workspace. Direct legacy Webhook or generic Event subscription
 * attribution plus an owning space kind are required.
 */
export function shouldRequestWebhookWorkspacePrune(
  enabled: boolean,
  input: WebhookTerminalWorkspacePolicyInput,
): boolean {
  return (
    enabled &&
    (input.to === 'done' || input.to === 'canceled') &&
    (input.webhookTriggerId !== null || input.eventSubscriptionId != null) &&
    (input.spaceKind === 'remote' || input.spaceKind === 'scratch') &&
    input.workspacePruningAt === null &&
    input.workspacePruneCause === null &&
    input.workspacePrunedAt === null
  )
}
