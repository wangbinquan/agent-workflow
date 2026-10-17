import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { DirectAuthorityIdentity } from '@/modules/identity-access/public/participants'
import { readHostedWorkspaceOwnerForBusinessTask } from '@/modules/source-control/public/participants'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import { createCrewStationRecoveryApi } from '@/platform/crewstation/recovery'
import type { Logger } from '@/util/log'
import { createHostedRecoveryConsumer } from '../infrastructure/crewstation/recoveryConsumer'
import { createHostedRecoveryJournal } from '../infrastructure/crewstation/recoveryJournal'
import type { TaskRecoveryDeploymentSelection } from './taskRecoverySelection'

/** RFC-370 §9.2 V4 — hosted platform recovery for AW tasks. The requester
 * resolver comes from Identity & Access through bootstrap. */
export function composeCrewStationRecovery(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly platform: CrewStationPlatformApi
  readonly api: Pick<CrewStationBusinessExecution, 'getTask'>
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly requesterFor: (identityAccess: Parameters<TaskRecoveryDeploymentSelection>[0]) => {
    resolve(requestedBy: string): Promise<DirectAuthorityIdentity | null>
  }
}): TaskRecoveryDeploymentSelection {
  return (identityAccess) => (context) => {
    if (context.db !== input.db) throw new Error('hosted-recovery-provider-changed')
    const requester = input.requesterFor(identityAccess)
    const consumer = createHostedRecoveryConsumer({
      recovery: createCrewStationRecoveryApi({ api: input.platform, fence: input.fence }),
      api: input.api,
      journal: createHostedRecoveryJournal({ db: input.db, fence: input.fence }),
      log: input.log,
      business: {
        async ownerTask(businessTaskId) {
          const owner = await readHostedWorkspaceOwnerForBusinessTask(input.db, businessTaskId)
          return owner?.taskId ?? null
        },
        async requester(requestedBy) {
          return (await requester.resolve(requestedBy))?.actor ?? null
        },
        assertManualExecutionAllowed: context.assertManualExecutionAllowed,
        async taskStatus(taskId) {
          const [row] = await input.db
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)
          return row?.status ?? null
        },
        resumeTask: context.resumeTaskAs,
      },
    })
    return {
      async tick() {
        // Only the execution-authority holder consumes platform requests.
        try {
          input.fence.current()
        } catch {
          return
        }
        await consumer.tick()
      },
    }
  }
}
