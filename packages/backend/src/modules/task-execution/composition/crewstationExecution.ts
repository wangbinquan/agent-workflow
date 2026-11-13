import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'
import type { HostedWorkspaceCommands } from '@/modules/source-control/public/participants'
import { hostedPrompt, readHostedPrompt } from '@/platform/content/locations/prompt'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { sha256Hex } from '@/util/hash'
import type { Logger } from '@/util/log'
import type { TaskDeletionEffects } from '../application/ports/taskDeletionContentEffects'
import { createHostedBootRecovery } from '../infrastructure/crewstation/bootRecovery'
import { createHostedExecution } from '../infrastructure/crewstation/execution'
import { createHostedExecutionSettler } from '../infrastructure/crewstation/executionSettler'
import { createHostedExecutionStore } from '../infrastructure/crewstation/executionStore'
import {
  createHostedExecutionWorkspaces,
  createOwnerRoutedWorkspaceHelper,
} from '../infrastructure/crewstation/executionWorkspaces'
import {
  createCachedHostedCapabilities,
  hostedProfileCapability,
} from '../infrastructure/crewstation/hostedCapabilities'
import { createHostedIntentScratchRelease } from '../infrastructure/crewstation/intentScratchRelease'
import { createHostedPortArtifactContent } from '../infrastructure/crewstation/portArtifactContent'
import { createHostedTaskDeletionContent } from '../infrastructure/crewstation/taskDeletionContent'
import { createHostedVolumeActivity } from '../infrastructure/crewstation/volumeActivity'
import { createHostedWorkspaceCommandReconciliation } from '../infrastructure/crewstation/workspaceCommandReconciliation'
import { createDaemonRecoveryAuthorityProof } from './bootRecovery'
import { composeCrewStationTaskRunSelection } from './crewstationTaskRunSelection'
import { composePortArtifactOperations } from './portArtifacts'

export function composeCrewStationExecutionOwner(
  input: {
    readonly db: PersistenceDb
    readonly fence: CrewStationMutationFence
    readonly api: CrewStationBusinessExecution
    readonly objects: CrewStationObjectStorage
    readonly initialCapabilities: HostedRuntimeCapabilities
    readonly capabilities: () => Promise<HostedRuntimeCapabilities>
    readonly commands: HostedWorkspaceCommands
    readonly publications: Parameters<typeof createHostedPortArtifactContent>[0]['publications']
    readonly taskDeletionRepositories: () => TaskDeletionEffects['repositories']
    readonly log: Pick<Logger, 'info' | 'warn'>
  } & Pick<
    Parameters<typeof composeCrewStationTaskRunSelection>[0],
    | 'profiles'
    | 'skills'
    | 'reference'
    | 'runtimeBindingsFor'
    | 'pluginFiles'
    | 'materialFiles'
    | 'materialEnvironment'
  > & {
      readonly workspaces: Parameters<typeof createHostedExecutionWorkspaces>[0]['workspaces'] &
        Parameters<typeof createHostedPortArtifactContent>[0]['workspace'] & {
          close(taskId: string): Promise<boolean>
        }
      readonly locate: Parameters<typeof createHostedPortArtifactContent>[0]['locate']
    },
) {
  const executionWorkspaces = createHostedExecutionWorkspaces(input)
  const store = createHostedExecutionStore(input)
  const executions = createHostedExecution({
    api: input.api,
    store,
    fence: input.fence,
    workspaceTaskId: executionWorkspaces.workspaceTaskId,
    readyWorkspace: executionWorkspaces.ensure,
  })
  const helper = createOwnerRoutedWorkspaceHelper(input.commands, executionWorkspaces.owner)
  const capabilities = createCachedHostedCapabilities(input.capabilities)
  const capability = hostedProfileCapability(capabilities)
  const hostedAgents = {
    db: input.db,
    fence: input.fence,
    api: input.api,
    executions,
    profiles: input.profiles,
    helper,
    reference: input.reference,
    workspaces: executionWorkspaces,
    startupInventoryAvailable: capability('startupInventoryVersion'),
    nativeConfigAvailable: capability('nativeConfigVersion'),
    nativeModelMappingAvailable: capability('nativeModelMappingVersion'),
    ...(input.pluginFiles === undefined ? {} : { pluginFiles: input.pluginFiles }),
    ...(input.materialEnvironment === undefined
      ? {}
      : { materialEnvironment: input.materialEnvironment }),
  }
  const portArtifactContentEffects = createHostedPortArtifactContent({
    ...input,
    helper,
    workspace: input.workspaces,
  })
  const recovery = createHostedBootRecovery({
    db: input.db,
    fence: input.fence,
    store,
    // RFC-328 FACTORY_ALLOWLIST: the proof is minted only through composition/bootRecovery.ts.
    proof() {
      const lease = input.fence.current()
      return createDaemonRecoveryAuthorityProof({
        daemonGeneration: lease.instanceId,
        acquiredAt: Date.now(),
        receiptDigest: sha256Hex(JSON.stringify(lease)),
      })
    },
  })
  const settler = createHostedExecutionSettler({
    db: input.db,
    store,
    executions,
    fence: input.fence,
    log: input.log,
  })
  return {
    helper,
    executions,
    /** Volume-use facts for Source Control's hosted parent lifecycle (§9.2 V3). */
    volumeActivity: createHostedVolumeActivity({ db: input.db, store }),
    /** Inputs every hosted Agent family (System Agent, MCP diagnostics,
     * runtime smoke) shares; assembled by bootstrap. RFC-489: bootstrap also pairs the hosted System Agent family and
     * runtime management with runtime-management's hosted contents and management. */
    hostedAgents: { ...hostedAgents, capabilities, initialCapabilities: input.initialCapabilities },
    backgroundOwners: [
      {
        id: 'hosted-execution-settlement',
        run: (signal: AbortSignal) => settler.run(signal),
      },
      createHostedWorkspaceCommandReconciliation({ commands: input.commands, log: input.log }),
    ],
    selections: {
      taskDeletionEffects: {
        content: createHostedTaskDeletionContent({
          helper,
          locate: input.locate,
          workspaces: input.workspaces,
        }),
        repositories: input.taskDeletionRepositories(),
      },
      bootExecutionRecovery: recovery.factory,
      recoveredExecutionTaskIds: recovery.recoveredTaskIds,
      taskRunSelection: composeCrewStationTaskRunSelection({
        ...hostedAgents,
        skills: input.skills,
        locate: input.locate,
        runtimeBindingsFor: input.runtimeBindingsFor,
        ...(input.materialFiles === undefined ? {} : { materialFiles: input.materialFiles }),
        materialObjectsAvailable: capability('materialObjectsVersion'),
        // Small prompts are durable DB content, never service-local files.
        nodeRunPrompts: {
          store: async (_taskId, _nodeRunId, prompt) => hostedPrompt(prompt),
          read: async (row) => readHostedPrompt(row),
        },
        portArtifacts: composePortArtifactOperations(portArtifactContentEffects),
      }),
    },
  }
}

/** The maintenance Worker releases Intent scratch only after every hosted
 * execution that may still write it has settled; it never adopts them. */
export function composeCrewStationIntentScratchRelease(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly helper: WorkspaceHelper
  readonly workspaces: {
    find(taskId: string): Promise<{ readonly businessTaskId: string } | null>
  }
}) {
  const store = createHostedExecutionStore(input)
  const executions = createHostedExecution({
    api: input.api,
    store,
    fence: input.fence,
    workspaceTaskId: async (taskId) =>
      (await input.workspaces.find(taskId))?.businessTaskId ?? null,
  })
  return createHostedIntentScratchRelease({
    executions,
    helper: input.helper,
    workspaces: input.workspaces,
  })
}
