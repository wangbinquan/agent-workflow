// RFC-301 — task-execution-owned launch-origin value and closed derivation.
//
// This domain module deliberately consumes only neutral shared values. It has
// no knowledge of Actor/Hono/Drizzle, integration trigger rows, or Fusion
// services. Inbound adapters translate trusted authentication into an
// initiator; application admission supplies the source-shaped provenance.

import type { TaskLaunchOrigin } from '@agent-workflow/shared'

export type DirectTaskInitiator = 'manual' | 'api'

export type TaskLaunchProvenance =
  | {
      kind: 'direct-json' | 'direct-multipart' | 'fusion'
      initiator: DirectTaskInitiator
    }
  | { kind: 'schedule' }
  | { kind: 'event' }
  | { kind: 'webhook' }

export interface RootTaskLaunchMetadata {
  scheduledTaskId?: string
  webhookTriggerId?: string
  webhookFireId?: string
  eventSubscriptionId?: string
  eventDeliveryId?: string
  hasTriggerContext: boolean
  /**
   * RFC-304 — this launch is a capability ROUND, anchored by its round row.
   *
   * A code capability is not a workflow trigger: a repository that switched on
   * MR review has written no trigger, so there is no `webhook_triggers` row and
   * therefore no fire to point at. What it does have is a `code_work_rounds`
   * row carrying the work item, the sequence number and the event trail — a
   * durable anchor of the same kind, reached by a different door.
   */
  hasCodeRound?: boolean
}

export interface TaskLaunchAdmissionIssue {
  code:
    | 'task-launch-schedule-metadata-invalid'
    | 'task-launch-event-metadata-invalid'
    | 'task-launch-webhook-metadata-invalid'
    | 'task-launch-direct-metadata-invalid'
  message: string
}

export function deriveTaskLaunchOrigin(provenance: TaskLaunchProvenance): TaskLaunchOrigin {
  if (provenance.kind === 'schedule') return 'scheduled'
  if (provenance.kind === 'event') return 'event'
  if (provenance.kind === 'webhook') return 'webhook'
  return provenance.initiator
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

function present(value: string | undefined): boolean {
  return value !== undefined
}

/**
 * Validate the root source against the attribution fields published in the
 * same initial task INSERT. TriggerContext's canonical schema remains owned by
 * the existing RFC-292 preflight; this gate requires its presence, while that
 * preflight preserves the precise trigger-context-invalid diagnostic.
 */
export function taskLaunchAdmissionIssue(
  provenance: TaskLaunchProvenance,
  metadata: RootTaskLaunchMetadata,
): TaskLaunchAdmissionIssue | null {
  const hasSchedule = nonEmpty(metadata.scheduledTaskId)
  const hasWebhookTrigger = nonEmpty(metadata.webhookTriggerId)
  const hasWebhookFire = nonEmpty(metadata.webhookFireId)
  const hasWebhookAttribution =
    present(metadata.webhookTriggerId) || present(metadata.webhookFireId)
  const hasAnyWebhookField = hasWebhookAttribution || metadata.hasTriggerContext
  const hasEventSubscription = nonEmpty(metadata.eventSubscriptionId)
  const hasEventDelivery = nonEmpty(metadata.eventDeliveryId)
  const hasEventAttribution =
    present(metadata.eventSubscriptionId) || present(metadata.eventDeliveryId)
  const hasAnyEventField = hasEventAttribution || metadata.hasTriggerContext

  if (provenance.kind === 'schedule') {
    if (!hasSchedule || hasAnyWebhookField || hasAnyEventField) {
      return {
        code: 'task-launch-schedule-metadata-invalid',
        message:
          'schedule launch provenance requires a non-empty scheduledTaskId and forbids webhook attribution/context',
      }
    }
    return null
  }

  if (provenance.kind === 'event') {
    if (
      present(metadata.scheduledTaskId) ||
      hasWebhookAttribution ||
      !hasEventSubscription ||
      !hasEventDelivery ||
      !metadata.hasTriggerContext
    ) {
      return {
        code: 'task-launch-event-metadata-invalid',
        message:
          'event launch provenance requires non-empty subscription/delivery ids and canonical trigger context, and forbids schedule/Webhook compatibility attribution',
      }
    }
    return null
  }

  if (provenance.kind === 'webhook') {
    // A webhook-origin root must be traceable to something durable. There are
    // two legitimate anchors, not one:
    //
    //   a TRIGGER FIRE — a person wrote a trigger and it fired.
    //   a CAPABILITY ROUND — a repository switched a capability on, and the
    //   delivery woke it. There is no trigger row to point at because a
    //   capability is deliberately not a trigger (RFC-304 §3.1), and the round
    //   row is the anchor instead.
    //
    // The requirement being enforced is "attributable", and admitting the
    // second shape states it more precisely than demanding trigger ids that
    // cannot exist. Naming it explicitly also keeps the check honest: an
    // ordinary trigger launch still needs BOTH ids, so a lost fire id does not
    // slip through by claiming to be a capability.
    const anchored = (hasWebhookTrigger && hasWebhookFire) || metadata.hasCodeRound === true
    if (
      present(metadata.scheduledTaskId) ||
      hasEventAttribution ||
      !anchored ||
      !metadata.hasTriggerContext
    ) {
      return {
        code: 'task-launch-webhook-metadata-invalid',
        message:
          'webhook launch provenance requires canonical context plus either non-empty trigger/fire ids or a capability round, and forbids scheduledTaskId',
      }
    }
    return null
  }

  if (present(metadata.scheduledTaskId) || hasAnyWebhookField || hasAnyEventField) {
    return {
      code: 'task-launch-direct-metadata-invalid',
      message: `${provenance.kind} launch provenance forbids scheduled/webhook root attribution`,
    }
  }
  return null
}
