import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeScheduledTaskRuntimeFor } from '@/modules/integration/composition/scheduledTasks'
import { composeIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import { assertNotBuiltin } from '@/services/systemResources'
import { assertWorkflowSnapshotLaunchable } from '@/services/taskLaunchGate'
import { triggerRevalidation } from '@/ws/revalidationHook'

/** RFC-381: save and dispatch admission use the same candidate-aware launch gate. */
export function composeDaemonScheduledTaskModules(input: {
  readonly db: PersistenceDb
  readonly assertAgentIntegrity: Parameters<
    typeof composeScheduledTaskRuntimeFor
  >[0]['validation']['assertAgentIntegrity']
}) {
  const resourceSnapshots = composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin })
  const scheduledTaskRuntime = composeScheduledTaskRuntimeFor({
    db: input.db,
    resourceSnapshots,
    validation: Object.freeze({
      assertWorkflowLaunchable: (
        workflow: Parameters<typeof assertWorkflowSnapshotLaunchable>[1],
      ) => assertWorkflowSnapshotLaunchable(input.db, workflow),
      assertAgentIntegrity: input.assertAgentIntegrity,
    }),
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
  return Object.freeze({ resourceSnapshots, scheduledTaskRuntime })
}
export type DaemonScheduledTaskModules = ReturnType<typeof composeDaemonScheduledTaskModules>
