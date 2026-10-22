import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'
import type { HostedWorkspaceCommands } from '@/modules/source-control/public/participants'
import type { Logger } from '@/util/log'
import { createHostedExecutionStore } from '../infrastructure/crewstation/executionStore'
import { createHostedExecution } from '../infrastructure/crewstation/execution'
import { createHostedExecutionSettler } from '../infrastructure/crewstation/executionSettler'
import { createHostedVolumeActivity } from '../infrastructure/crewstation/volumeActivity'
import { createHostedPortArtifactContent } from '../infrastructure/crewstation/portArtifactContent'
import { createHostedBootRecovery } from '../infrastructure/crewstation/bootRecovery'
import { createHostedTaskDeletionContent } from '../infrastructure/crewstation/taskDeletionContent'
import type { TaskDeletionEffects } from '../application/ports/taskDeletionContentEffects'
import { createDaemonRecoveryAuthorityProof } from './bootRecovery'
import { composeCrewStationTaskRunSelection } from './crewstationTaskRunSelection'
import { composePortArtifactOperations } from './portArtifacts'
import { createCrewStationSystemAgentRunFamily } from './crewstationSystemAgentRunFamily'
import { createCrewStationRuntimeManagement } from './crewstationRuntimeManagement'
import { sha256Hex } from '@/util/hash'

const CAPABILITY_CACHE_MS = 30_000
const SETTLEMENT_INTERVAL_MS = 60_000

/** Bind logical child executions to the physical volume owning their workspace. */
export function createCrewStationExecutionWorkspaces(input: {
  readonly db: PersistenceDb
  readonly locate: (reference: string) => { readonly taskId: string }
  readonly workspaces: {
    ensure(taskId: string): Promise<{ readonly businessTaskId: string }>
    find(taskId: string): Promise<{ readonly businessTaskId: string } | null>
  }
}) {
  // Inherited call/fusion children own their execution identity but operate in
  // their parent's physical workspace. Resolve that owner before allocating a
  // platform parent; never create an empty child volume for a parent cwd.
  const owner = async (taskId: string) => {
    const { tasks } = tablesOf(input.db)
    const task = (
      await input.db
        .select({ workspaceRef: tasks.worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    return task !== undefined && task.workspaceRef !== ''
      ? input.locate(task.workspaceRef).taskId
      : taskId
  }
  return {
    owner,
    async ensure(taskId: string) {
      return input.workspaces.ensure(await owner(taskId))
    },
    async workspaceTaskId(taskId: string) {
      return (await input.workspaces.find(await owner(taskId)))?.businessTaskId ?? null
    },
  }
}

/** Platform capability evidence changes only when a profile is re-tested;
 * one cached read serves every compile in that window. */
export function createCachedHostedCapabilities(
  read: () => Promise<HostedRuntimeCapabilities>,
  now: () => number = Date.now,
): () => Promise<HostedRuntimeCapabilities> {
  let value: HostedRuntimeCapabilities | undefined
  let readAt = 0
  let pending: Promise<HostedRuntimeCapabilities> | undefined
  return async () => {
    if (value !== undefined && now() - readAt < CAPABILITY_CACHE_MS) return value
    pending ??= read()
      .then((fresh) => {
        value = fresh
        readAt = now()
        return fresh
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

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
      readonly workspaces: Parameters<
        typeof createCrewStationExecutionWorkspaces
      >[0]['workspaces'] &
        Parameters<typeof createHostedPortArtifactContent>[0]['workspace'] & {
          close(taskId: string): Promise<boolean>
        }
      readonly locate: Parameters<typeof createHostedPortArtifactContent>[0]['locate']
    },
) {
  const executionWorkspaces = createCrewStationExecutionWorkspaces(input)
  const store = createHostedExecutionStore(input)
  const executions = createHostedExecution({
    api: input.api,
    store,
    fence: input.fence,
    workspaceTaskId: executionWorkspaces.workspaceTaskId,
    readyWorkspace: executionWorkspaces.ensure,
  })
  // Source Control owns the command journal; logical children borrow their
  // parent's volume, so commands always address the physical owner.
  const helper: WorkspaceHelper & {
    recover<T>(taskId: string, operationId: string): Promise<{ value: T } | null>
  } = {
    call: async (taskId, operation, value, options) =>
      input.commands.call(await executionWorkspaces.owner(taskId), operation, value, options),
    recover: async (taskId, operationId) =>
      input.commands.recover(await executionWorkspaces.owner(taskId), operationId),
  }
  const capabilities = createCachedHostedCapabilities(input.capabilities)
  const capability =
    (
      name:
        | 'startupInventoryVersion'
        | 'nativeConfigVersion'
        | 'nativeModelMappingVersion'
        | 'materialObjectsVersion',
    ) =>
    async (agentProfileId: string) =>
      (await capabilities()).agentProfiles.some(
        (profile) => profile.agentProfileId === agentProfileId && profile.capabilities[name] === 1,
      )
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
     * runtime smoke) shares; assembled by bootstrap. */
    hostedAgents: { ...hostedAgents, capabilities, initialCapabilities: input.initialCapabilities },
    backgroundOwners: [
      {
        id: 'hosted-execution-settlement',
        run: (signal: AbortSignal) => settler.run(signal),
      },
      {
        // Commands of earlier owners are settled from their platform result;
        // a long one never delays the next pass (in-flight rows are skipped).
        id: 'hosted-workspace-command-reconciliation',
        async run(signal: AbortSignal) {
          while (!signal.aborted) {
            input.commands.reconcile(signal).catch((error: unknown) => {
              input.log.warn('hosted workspace command reconciliation failed', {
                reason: error instanceof Error ? error.message : String(error),
              })
            })
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, SETTLEMENT_INTERVAL_MS)
              function done(): void {
                clearTimeout(timer)
                signal.removeEventListener('abort', done)
                resolve()
              }
              signal.addEventListener('abort', done, { once: true })
            })
          }
        },
      },
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
      systemAgentRunFamily: createCrewStationSystemAgentRunFamily(hostedAgents),
      runtimeManagement: createCrewStationRuntimeManagement({
        ...hostedAgents,
        initialCapabilities: input.initialCapabilities,
        capabilities,
      }),
      bootExecutionRecovery: recovery.factory,
      recoveredExecutionTaskIds: recovery.recoveredTaskIds,
      portArtifactContentEffects,
      taskRunSelection: composeCrewStationTaskRunSelection({
        ...hostedAgents,
        skills: input.skills,
        locate: input.locate,
        runtimeBindingsFor: input.runtimeBindingsFor,
        ...(input.materialFiles === undefined ? {} : { materialFiles: input.materialFiles }),
        materialObjectsAvailable: capability('materialObjectsVersion'),
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
  return {
    async removeIntentScratch(turnId: string) {
      const taskId = 'system:intent'
      const key = sha256Hex(turnId)
      if (!(await executions.workspaceSettled(taskId, `/work/system/intent/${key}`)))
        throw new Error('hosted-intent-scratch-execution-unsettled')
      if ((await input.workspaces.find(taskId)) === null) return
      const result = await input.helper.call<{ removed: boolean }>(
        taskId,
        'system-workspace',
        { method: 'release', namespace: 'intent', key },
        { operationId: `intent-scratch:${turnId}:retention` },
      )
      if (!result.removed) throw new Error('hosted-intent-scratch-release-failed')
    },
  }
}
