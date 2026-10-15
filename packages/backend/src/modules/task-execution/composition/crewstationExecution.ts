import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import { createHostedExecutionStore } from '../infrastructure/crewstation/executionStore'
import { createHostedExecution } from '../infrastructure/crewstation/execution'
import { createHostedWorkspaceHelper } from '../infrastructure/crewstation/workspaceCommands'
import { createHostedPortArtifactContent } from '../infrastructure/crewstation/portArtifactContent'
import { createHostedBootRecovery } from '../infrastructure/crewstation/bootRecovery'
import { createDaemonRecoveryAuthorityProof } from './bootRecovery'
import { composeCrewStationTaskRunSelection } from './crewstationTaskRunSelection'
import { composePortArtifactOperations } from './portArtifacts'

export function composeCrewStationExecutionOwner(
  input: {
    readonly db: ProviderNeutralDatabase
    readonly fence: CrewStationMutationFence
    readonly api: CrewStationBusinessExecution
    readonly objects: CrewStationObjectStorage
  } & Pick<
    Parameters<typeof composeCrewStationTaskRunSelection>[0],
    'profiles' | 'skills' | 'reference' | 'runtimeBindingsFor'
  > & {
      readonly workspaces: Parameters<typeof createHostedWorkspaceHelper>[0]['workspace'] &
        Parameters<typeof createHostedPortArtifactContent>[0]['workspace']
      readonly locate: Parameters<typeof createHostedPortArtifactContent>[0]['locate']
    },
) {
  const store = createHostedExecutionStore(input)
  const executions = createHostedExecution({ ...input, store })
  const helper = createHostedWorkspaceHelper({ executions, workspace: input.workspaces })
  const portArtifactContentEffects = createHostedPortArtifactContent({
    ...input,
    helper,
    workspace: input.workspaces,
  })
  const recovery = createHostedBootRecovery({
    ...input,
    store,
    executions,
    proof() {
      const lease = input.fence.current()
      return createDaemonRecoveryAuthorityProof({
        daemonGeneration: lease.instanceId,
        acquiredAt: Date.now(),
        receiptDigest: createHash('sha256').update(JSON.stringify(lease)).digest('hex'),
      })
    },
  })
  return {
    helper,
    selections: {
      bootExecutionRecovery: recovery.factory,
      recoveredExecutionTaskIds: recovery.recoveredTaskIds,
      portArtifactContentEffects,
      taskRunSelection: composeCrewStationTaskRunSelection({
        ...input,
        helper,
        executions,
        // Small prompts are durable DB content, never service-local files.
        nodeRunPrompts: {
          store: async (_taskId, _nodeRunId, prompt) => ({ promptText: prompt, promptPath: null }),
          read: async (row) => row?.promptText ?? null,
        },
        portArtifacts: composePortArtifactOperations(portArtifactContentEffects),
      }),
    },
  }
}
