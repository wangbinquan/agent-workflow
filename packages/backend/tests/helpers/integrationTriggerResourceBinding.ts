import type { Actor } from '../../src/auth/actor'
// RFC-359 AC-6：`db` 放宽到 `PersistenceDb`，装配也换成中立那一份
// （`composeResourceCatalogFor` / `composeScheduledTaskRuntimeFor`——`composeSqlite*` 本来就只是
// 它们的装配别名，函数体逐字相同）。定时任务这一族的三个测试文件全卡在这个夹具上。
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeIdentityAccess,
  type IdentityAccessRuntime,
} from '../../src/modules/identity-access/composition'
import { composeIntegrationTriggerResourceSnapshotFactory } from '../../src/modules/resource-catalog/composition/integrationTrigger'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import { composeResourceCatalogFor } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseAgentResourceInventorySource } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { createTaskExecutionResourceBinding } from '../../src/services/execution/taskExecutionResources'
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
import { taskExecutionResourceDependencies } from '../../src/services/execution/taskExecutionResourceDependencies'
import { composeScheduledTaskRuntimeFor } from '../../src/modules/integration/composition/scheduledTasks'
import { assertWorkflowSnapshotLaunchable } from '../../src/services/taskLaunchGate'
import { assertAgentResourceIntegrity } from '../../src/modules/resource-catalog/application/agents/agentResourceIntegrity'
import { triggerRevalidation } from '../../src/ws/revalidationHook'

export function integrationTriggerResourceBinding() {
  return composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin })
}

export function taskExecutionResourceBinding(db: PersistenceDb) {
  return createTaskExecutionResourceBinding(db, {
    inTransaction(tx, pair) {
      return composeTaskExecutionResourceBinding(taskExecutionResourceDependencies).inTransaction(
        tx,
        pair,
      )
    },
  })
}

export function scheduledTaskRuntime(db: PersistenceDb) {
  const resourceCatalog = composeResourceCatalogFor({ db })
  const agentResourceInventory = composeDatabaseAgentResourceInventorySource({
    db,
    authorization: resourceCatalog.authorization,
  })
  return composeScheduledTaskRuntimeFor({
    db,
    resourceSnapshots: integrationTriggerResourceBinding(),
    validation: {
      assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(db, workflow),
      assertAgentIntegrity: (agentIds) =>
        assertAgentResourceIntegrity(agentResourceInventory, agentIds),
    },
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
}

export function integrationTriggerResourceAuthority(
  db: PersistenceDb,
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

export function integrationTriggerOptions(db: PersistenceDb, actor: Actor) {
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
  db: PersistenceDb,
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
  db: PersistenceDb,
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

export function listScheduledTasks(db: PersistenceDb) {
  return listScheduledTasksService(scheduledTaskRuntime(db).operations)
}

export function listScheduledTaskItems(
  db: PersistenceDb,
  actor: Parameters<typeof listScheduledTaskItemsService>[1],
) {
  return listScheduledTaskItemsService(scheduledTaskRuntime(db).operations, actor)
}

export function getScheduledTask(db: PersistenceDb, id: string) {
  return getScheduledTaskService(scheduledTaskRuntime(db).operations, id)
}

export function getScheduledTaskRow(db: PersistenceDb, id: string) {
  return getScheduledTaskRowService(scheduledTaskRuntime(db).operations, id)
}

export function deleteScheduledTask(db: PersistenceDb, id: string) {
  return deleteScheduledTaskService(scheduledTaskRuntime(db).operations, id)
}

export function healScheduledLaunchPayloads(db: PersistenceDb) {
  return healScheduledLaunchPayloadsService(scheduledTaskRuntime(db).operations)
}

export function fireSchedule(
  db: PersistenceDb,
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
  db: PersistenceDb,
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
  _db: PersistenceDb,
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

export function integrationTriggerWebhookAuthorityDependencies(
  db: PersistenceDb,
  identityAccess: IdentityAccessRuntime,
) {
  return Object.freeze({
    identityAccess: withIntegrationTriggerResources(db, identityAccess),
  })
}
