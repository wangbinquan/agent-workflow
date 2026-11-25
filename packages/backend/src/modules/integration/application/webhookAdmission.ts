// RFC-501 (RFC-294 S10 step 8): the webhook launch admission and trigger save validation, moved here unchanged from
// composition/webhookAdmission.ts; the two factories are now named create… (the composition file is gone).
import type { Actor } from '@/auth/actor'
import type { WebhookConfigurationQuery } from './ports/webhookConfiguration'
import type { FrozenIntegrationTriggerResourceSnapshot } from '@/modules/resource-catalog/public/types'
import { assertTriggerPreflight } from '@/modules/resource-catalog/public/queries'
import {
  assertIntegrationTriggerSnapshotUsable,
  assertScheduledTargetUsable,
  loadIntegrationTriggerResourceSnapshot,
  type ScheduledTaskOperations,
} from './scheduledTasks'
import type { IntegrationTriggerResourceAuthority } from './ports/scheduledTaskPersistence'
import {
  renderWebhookLaunch,
  type RenderedLaunch,
  type WebhookDispatchDeps,
} from './webhookDispatch'
import {
  rehearsalEvent,
  staticTriggerIssues,
  type WebhookTriggerSaveCandidate,
} from '../domain/webhookTriggerValidation'
import type { WebhookTriggerServiceDeps } from './webhookTriggers'
import { ValidationError } from '@/platform/errors/domainErrors'
import { webhookPayloadTemplateSchemaFor, type WorkflowDefinition } from '@agent-workflow/shared'

/**
 * Provider-neutral launch admission. The selected scheduled-task runtime owns
 * the database mechanism; webhook dispatch only consumes its closed resource
 * and validation ports.
 */
export function createWebhookLaunchAdmission(
  operations: ScheduledTaskOperations,
): WebhookDispatchDeps['admitLaunch'] {
  return async (input) => {
    if (input.rendered.kind === 'digital-employee') {
      const snapshot = await loadIntegrationTriggerResourceSnapshot(input.resourceAuthority, {
        kind: 'webhook-digital-employee',
        employeeDefinitionId: input.rendered.refId,
      })
      await assertIntegrationTriggerSnapshotUsable(
        operations,
        input.resourceAuthority,
        snapshot,
        input.rendered.intake as unknown as Record<string, unknown>,
      )
      return
    }
    await assertScheduledTargetUsable(
      operations,
      input.resourceAuthority,
      input.rendered.kind,
      input.rendered.payload as unknown as Record<string, unknown>,
      input.defaultRuntime,
      { kind: 'context', value: input.triggerContext },
      'webhook',
    )
  }
}

export async function assertWebhookTriggerSaveable(
  operations: ScheduledTaskOperations,
  actor: Actor,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  candidate: WebhookTriggerSaveCandidate,
  defaultRuntime: string | null | undefined,
): Promise<void> {
  if (actor !== resourceAuthority.actor) throw new Error('foreign-webhook-trigger-actor')
  const parsedPayload = webhookPayloadTemplateSchemaFor(candidate.launchKind).safeParse(
    candidate.launchPayload,
  )
  if (!parsedPayload.success) {
    throw new ValidationError('webhook-trigger-invalid', 'invalid launch payload', {
      issues: parsedPayload.error.issues,
    })
  }
  const payload = parsedPayload.data
  let workflowDefinition: WorkflowDefinition | null = null
  let workflowClosureJson: string | null = null
  let resourceSnapshot: FrozenIntegrationTriggerResourceSnapshot | null = null
  if (candidate.launchKind === 'workflow') {
    resourceSnapshot = await loadIntegrationTriggerResourceSnapshot(resourceAuthority, {
      kind: 'webhook-workflow',
      workflowId: candidate.launchRefId,
    })
    if (resourceSnapshot.kind !== 'webhook-workflow') {
      throw new Error('webhook-workflow-snapshot-kind-mismatch')
    }
    workflowDefinition = resourceSnapshot.workflow.definition
    workflowClosureJson = await resourceAuthority.taskExecutionResources.freezeCallClosure(
      Object.freeze({
        authority: resourceAuthority.authority,
        actor: resourceAuthority.actor,
      }),
      { id: candidate.launchRefId, definition: workflowDefinition },
    )
  }
  if (candidate.launchKind === 'digital-employee') {
    resourceSnapshot = await loadIntegrationTriggerResourceSnapshot(resourceAuthority, {
      kind: 'webhook-digital-employee',
      employeeDefinitionId: candidate.launchRefId,
    })
  }
  const issues = staticTriggerIssues(
    candidate.launchKind,
    payload,
    candidate.eventTypes,
    workflowDefinition?.inputs ?? null,
  )
  const payloadScratch = 'scratch' in payload && payload.scratch === true
  if (payloadScratch && candidate.autoRegisterRepos !== false) {
    issues.push({
      code: 'scratch-auto-register-conflict',
      detail: 'autoRegisterRepos must be false when launchPayload.scratch is true',
    })
  }
  if (issues.length > 0) {
    throw new ValidationError('webhook-trigger-invalid', 'trigger static validation failed', {
      issues,
    })
  }
  if (workflowDefinition !== null) {
    assertTriggerPreflight({
      root: workflowDefinition,
      closureJson: workflowClosureJson,
      source: { kind: 'event-types', eventTypes: candidate.eventTypes },
    })
  }
  const rendered: RenderedLaunch = renderWebhookLaunch(
    {
      launchKind: candidate.launchKind,
      launchRefId: candidate.launchRefId,
      payloadTemplate: payload,
    },
    'rehearsal',
    rehearsalEvent(candidate.eventTypes[0] ?? 'push'),
    payloadScratch
      ? { kind: 'scratch' }
      : { kind: 'url', repoUrl: 'https://rehearsal.invalid/repo.git' },
  )
  if (rendered.kind === 'digital-employee') {
    if (resourceSnapshot === null) throw new Error('digital-employee-snapshot-missing')
    await assertIntegrationTriggerSnapshotUsable(
      operations,
      resourceAuthority,
      resourceSnapshot,
      payload as unknown as Record<string, unknown>,
    )
    return
  }
  if (rendered.kind === 'workflow') {
    if (resourceSnapshot === null) throw new Error('webhook-workflow-snapshot-missing')
    await assertIntegrationTriggerSnapshotUsable(
      operations,
      resourceAuthority,
      resourceSnapshot,
      rendered.payload as unknown as Record<string, unknown>,
      { kind: 'event-types', eventTypes: candidate.eventTypes },
    )
    return
  }
  await assertScheduledTargetUsable(
    operations,
    resourceAuthority,
    rendered.kind,
    rendered.payload as unknown as Record<string, unknown>,
    defaultRuntime,
    { kind: 'event-types', eventTypes: candidate.eventTypes },
    'webhook',
  )
}

export function createWebhookTriggerValidation(
  operations: ScheduledTaskOperations,
  configuration: WebhookConfigurationQuery,
): WebhookTriggerServiceDeps['validateSaveable'] {
  return async (actor, resourceAuthority, candidate) => {
    let defaultRuntime: string | null | undefined
    try {
      defaultRuntime = (await configuration.read()).defaultRuntime
    } catch {
      defaultRuntime = undefined
    }
    await assertWebhookTriggerSaveable(
      operations,
      actor,
      resourceAuthority,
      candidate,
      defaultRuntime,
    )
  }
}
