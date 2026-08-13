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
  | { kind: 'webhook' }

export interface RootTaskLaunchMetadata {
  scheduledTaskId?: string
  webhookTriggerId?: string
  webhookFireId?: string
  hasTriggerContext: boolean
}

export interface TaskLaunchAdmissionIssue {
  code:
    | 'task-launch-schedule-metadata-invalid'
    | 'task-launch-webhook-metadata-invalid'
    | 'task-launch-direct-metadata-invalid'
  message: string
}

export function deriveTaskLaunchOrigin(provenance: TaskLaunchProvenance): TaskLaunchOrigin {
  if (provenance.kind === 'schedule') return 'scheduled'
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
  const hasAnyWebhookField =
    present(metadata.webhookTriggerId) ||
    present(metadata.webhookFireId) ||
    metadata.hasTriggerContext

  if (provenance.kind === 'schedule') {
    if (!hasSchedule || hasAnyWebhookField) {
      return {
        code: 'task-launch-schedule-metadata-invalid',
        message:
          'schedule launch provenance requires a non-empty scheduledTaskId and forbids webhook attribution/context',
      }
    }
    return null
  }

  if (provenance.kind === 'webhook') {
    if (
      present(metadata.scheduledTaskId) ||
      !hasWebhookTrigger ||
      !hasWebhookFire ||
      !metadata.hasTriggerContext
    ) {
      return {
        code: 'task-launch-webhook-metadata-invalid',
        message:
          'webhook launch provenance requires non-empty trigger/fire ids plus canonical context and forbids scheduledTaskId',
      }
    }
    return null
  }

  if (present(metadata.scheduledTaskId) || hasAnyWebhookField) {
    return {
      code: 'task-launch-direct-metadata-invalid',
      message: `${provenance.kind} launch provenance forbids scheduled/webhook root attribution`,
    }
  }
  return null
}
