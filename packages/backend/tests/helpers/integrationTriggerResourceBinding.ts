import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import {
  composeIdentityAccess,
  type IdentityAccessRuntime,
} from '../../src/modules/identity-access/composition'
import { composeDigitalEmployeeIntegrationTriggerParticipant } from '../../src/modules/digital-employee/composition'
import { composeIntegrationTriggerResourceBinding } from '../../src/modules/resource-catalog/composition/integrationTrigger'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import { composeSqliteResourceCatalog } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeSqliteAgentResourceInventorySource } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { createSqliteTaskExecutionResourceBinding } from '../../src/services/execution/taskExecutionResources'
import { canViewResourceInTx } from '../../src/modules/resource-catalog/composition/resourceAcl'
import { rowToAgent } from '../../src/services/agent'
import { assertNotBuiltin } from '../../src/services/systemResources'
import {
  createScheduledTask as createScheduledTaskService,
  deleteScheduledTask as deleteScheduledTaskService,
  fireSchedule as fireScheduleService,
  getScheduledTask as getScheduledTaskService,
  getScheduledTaskRow as getScheduledTaskRowService,
  healScheduledLaunchPayloads as healScheduledLaunchPayloadsService,
  listScheduledTaskItems as listScheduledTaskItemsService,
  listScheduledTasks as listScheduledTasksService,
  runScheduleNow as runScheduleNowService,
  type IntegrationTriggerResourceAuthority,
  updateScheduledTask as updateScheduledTaskService,
} from '../../src/services/scheduledTasks'
import { rowToWorkflowDetail } from '../../src/services/workflow'
import { rowToWorkgroup } from '../../src/services/workgroups'
import { legacyTaskExecutionResourceDependencies } from '../../src/services/execution/legacyTaskExecutionResourceDependencies'
import { composeSqliteScheduledTaskRuntime } from '../../src/modules/integration/composition/scheduledTasks'
import { assertWorkflowSnapshotLaunchable } from '../../src/services/taskLaunchGate'
import { assertAgentResourceIntegrity } from '../../src/modules/resource-catalog/application/agents/agentResourceIntegrity'
import { triggerRevalidation } from '../../src/ws/revalidationHook'

export function integrationTriggerResourceBinding() {
  return composeIntegrationTriggerResourceBinding(
    { canViewResourceInTx, rowToAgent, rowToWorkflowDetail, rowToWorkgroup, assertNotBuiltin },
    composeDigitalEmployeeIntegrationTriggerParticipant,
  )
}

export function taskExecutionResourceBinding(db: DbClient) {
  return createSqliteTaskExecutionResourceBinding(db, {
    inTransaction(tx, pair) {
      return composeTaskExecutionResourceBinding(
        legacyTaskExecutionResourceDependencies,
      ).inTransaction(tx, pair)
    },
  })
}

export function scheduledTaskRuntime(db: DbClient) {
  const resourceCatalog = composeSqliteResourceCatalog({ db })
  const agentResourceInventory = composeSqliteAgentResourceInventorySource({
    db,
    authorization: resourceCatalog.authorization,
  })
  return composeSqliteScheduledTaskRuntime({
    db,
    resources: integrationTriggerResourceBinding(),
    validation: {
      assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(db, workflow),
      assertAgentIntegrity: (agentIds) =>
        assertAgentResourceIntegrity(agentResourceInventory, agentIds),
    },
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
}

export function integrationTriggerResourceAuthority(
  db: DbClient,
  actor: Actor,
  runtime = scheduledTaskRuntime(db),
): IntegrationTriggerResourceAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({
    authority: context.authority,
    actor,
    resources: runtime.integrationTriggerResources,
    taskExecutionResources: taskExecutionResourceBinding(db),
  })
}

export function integrationTriggerOptions(db: DbClient, actor: Actor) {
  const runtime = scheduledTaskRuntime(db)
  return Object.freeze({
    operations: runtime.operations,
    actor,
    resourceAuthority: integrationTriggerResourceAuthority(db, actor, runtime),
  })
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
  const runtime = scheduledTaskRuntime(db)
  return createScheduledTaskService(runtime.operations, input, {
    ...options,
    resourceAuthority: integrationTriggerResourceAuthority(db, options.actor, runtime),
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
  const runtime = scheduledTaskRuntime(db)
  return updateScheduledTaskService(runtime.operations, id, input, {
    ...options,
    resourceAuthority: integrationTriggerResourceAuthority(db, options.actor, runtime),
  })
}

export function listScheduledTasks(db: DbClient) {
  return listScheduledTasksService(scheduledTaskRuntime(db).operations)
}

export function listScheduledTaskItems(
  db: DbClient,
  actor: Parameters<typeof listScheduledTaskItemsService>[1],
) {
  return listScheduledTaskItemsService(scheduledTaskRuntime(db).operations, actor)
}

export function getScheduledTask(db: DbClient, id: string) {
  return getScheduledTaskService(scheduledTaskRuntime(db).operations, id)
}

export function getScheduledTaskRow(db: DbClient, id: string) {
  return getScheduledTaskRowService(scheduledTaskRuntime(db).operations, id)
}

export function deleteScheduledTask(db: DbClient, id: string) {
  return deleteScheduledTaskService(scheduledTaskRuntime(db).operations, id)
}

export function healScheduledLaunchPayloads(db: DbClient) {
  return healScheduledLaunchPayloadsService(scheduledTaskRuntime(db).operations)
}

export function fireSchedule(
  db: DbClient,
  row: Parameters<typeof fireScheduleService>[1],
  buildLaunch: Parameters<typeof fireScheduleService>[2],
  now: number,
  identityAccess: Parameters<typeof fireScheduleService>[4],
  invocation: Parameters<typeof fireScheduleService>[5],
  defaultRuntime?: string | null,
) {
  return fireScheduleService(
    scheduledTaskRuntime(db).operations,
    row,
    buildLaunch,
    now,
    identityAccess,
    invocation,
    defaultRuntime,
  )
}

export function runScheduleNow(
  db: DbClient,
  id: string,
  buildLaunch: Parameters<typeof runScheduleNowService>[2],
  identityAccess: Parameters<typeof runScheduleNowService>[3],
  defaultRuntime?: string | null,
) {
  return runScheduleNowService(
    scheduledTaskRuntime(db).operations,
    id,
    buildLaunch,
    identityAccess,
    defaultRuntime,
  )
}

export function withIntegrationTriggerResources<T extends IdentityAccessRuntime>(
  _db: DbClient,
  identityAccess: T,
): T &
  Readonly<{
    integrationTriggerResources: IntegrationTriggerResourceAuthority['resources']
    taskExecutionResources: ReturnType<typeof taskExecutionResourceBinding>
  }> {
  return Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime(_db).integrationTriggerResources,
    taskExecutionResources: taskExecutionResourceBinding(_db),
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
