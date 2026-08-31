import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import {
  composeIdentityAccess,
  type IdentityAccessRuntime,
} from '../../src/modules/identity-access/composition'
import { composeDigitalEmployeeIntegrationTriggerParticipant } from '../../src/modules/digital-employee/composition'
import { composeIntegrationTriggerResourceBinding } from '../../src/modules/resource-catalog/composition/integrationTrigger'
import { canViewResourceInTx } from '../../src/modules/resource-catalog/composition/resourceAcl'
import { rowToAgent } from '../../src/services/agent'
import { assertNotBuiltin } from '../../src/services/systemResources'
import {
  createScheduledTask as createScheduledTaskService,
  type IntegrationTriggerResourceAuthority,
  updateScheduledTask as updateScheduledTaskService,
} from '../../src/services/scheduledTasks'
import { rowToWorkflowDetail } from '../../src/services/workflow'
import { rowToWorkgroup } from '../../src/services/workgroups'

export function integrationTriggerResourceBinding() {
  return composeIntegrationTriggerResourceBinding(
    { canViewResourceInTx, rowToAgent, rowToWorkflowDetail, rowToWorkgroup, assertNotBuiltin },
    composeDigitalEmployeeIntegrationTriggerParticipant,
  )
}

export function integrationTriggerResourceAuthority(
  db: DbClient,
  actor: Actor,
): IntegrationTriggerResourceAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({
    authority: context.authority,
    actor,
    resources: integrationTriggerResourceBinding(),
  })
}

export function integrationTriggerOptions(db: DbClient, actor: Actor) {
  return Object.freeze({ actor, resourceAuthority: integrationTriggerResourceAuthority(db, actor) })
}

type CreateScheduledTaskInput = Parameters<typeof createScheduledTaskService>[1]
type CreateScheduledTaskOptions = Omit<
  Parameters<typeof createScheduledTaskService>[2],
  'resourceAuthority'
>

export function createScheduledTaskWithIntegrationTriggerResources(
  db: DbClient,
  input: CreateScheduledTaskInput,
  options: CreateScheduledTaskOptions,
) {
  return createScheduledTaskService(db, input, {
    ...options,
    resourceAuthority: integrationTriggerResourceAuthority(db, options.actor),
  })
}

type UpdateScheduledTaskInput = Parameters<typeof updateScheduledTaskService>[2]
type UpdateScheduledTaskOptions = Omit<
  Parameters<typeof updateScheduledTaskService>[3],
  'resourceAuthority'
>

export function updateScheduledTaskWithIntegrationTriggerResources(
  db: DbClient,
  id: string,
  input: UpdateScheduledTaskInput,
  options: UpdateScheduledTaskOptions,
) {
  return updateScheduledTaskService(db, id, input, {
    ...options,
    resourceAuthority: integrationTriggerResourceAuthority(db, options.actor),
  })
}

export function withIntegrationTriggerResources<T extends IdentityAccessRuntime>(
  _db: DbClient,
  identityAccess: T,
): T &
  Readonly<{
    integrationTriggerResources: ReturnType<typeof integrationTriggerResourceBinding>
  }> {
  return Object.freeze({
    ...identityAccess,
    integrationTriggerResources: integrationTriggerResourceBinding(),
  })
}

export function eventTargetAuthorityResolver(identityAccess: IdentityAccessRuntime) {
  return async (userId: string) => {
    const admitted = await identityAccess.localOperator.forLegacyHttpUser(userId)
    if (admitted === null) return null
    return Object.freeze({
      authority: admitted.commandContext().authority,
      actor: admitted.actor,
    })
  }
}

export function integrationTriggerWebhookAuthorityDependencies(
  db: DbClient,
  identityAccess: IdentityAccessRuntime,
) {
  return Object.freeze({
    identityAccess: withIntegrationTriggerResources(db, identityAccess),
    resolveEventTargetAuthority: eventTargetAuthorityResolver(identityAccess),
  })
}
