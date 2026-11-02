// RFC-417: the hosted (CrewStation) task Agent run scope, moved verbatim from
// composition/crewstationTaskRunSelection.ts. The run directory, seed writes, git-control observation and output
// validation through the workspace helper, and the managed-skill staging rule are platform adapter work;
// composition keeps only the selection that ensures the physical workspace and hands this scope out.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  AgentMaterialWorkspace,
  TaskAgentRuntimeBindings,
} from '@/modules/runtime-management/public/participants'
import type { SkillPackageContentReader } from '@/modules/resource-catalog/public/participants'
import type { NodeRunPromptOperations } from '../../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../../application/ports/portArtifactContent'
import type { TaskRunFamilyBinding } from '../../application/ports/taskRunSelection'
import type { TaskAgentRunScope } from '../../application/ports/taskAgentRunFamily'
import type { TaskAgentRunPurpose } from '../../application/ports/taskAgentMaterial'
import { createTaskAgentMaterialPreparation } from '../../application/taskAgentMaterialPreparation'
import {
  createHostedAgentInvocationPreparation,
  type HostedAgentParticipants,
  type HostedAgentProfile,
} from './agentInvocationPreparation'
import type { HostedExecution } from './execution'

/** The hosted task-run selection's inputs (declared with the adapter that interprets them). */
export interface HostedTaskRunSelectionInput {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly executions: HostedExecution
  readonly helper: WorkspaceHelper
  readonly profiles: readonly HostedAgentProfile[]
  readonly materialEnvironment?: Parameters<
    typeof createHostedAgentInvocationPreparation
  >[0]['materialEnvironment']
  readonly pluginFiles?: Parameters<typeof createHostedAgentInvocationPreparation>[0]['pluginFiles']
  readonly materialFiles?: Parameters<
    typeof createHostedAgentInvocationPreparation
  >[0]['materialFiles']
  readonly materialObjectsAvailable?: (agentProfileId: string) => Promise<boolean>
  readonly nativeConfigAvailable?: (agentProfileId: string) => Promise<boolean>
  readonly nativeModelMappingAvailable?: (agentProfileId: string) => Promise<boolean>
  readonly startupInventoryAvailable?: (agentProfileId: string) => Promise<boolean>
  readonly skills: SkillPackageContentReader
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
  readonly reference: (taskId: string, path: string) => string
  readonly runtimeBindingsFor: (
    binding: Pick<TaskRunFamilyBinding, 'nodeRunRuntime' | 'runtimeRegistry'>,
  ) => TaskAgentRuntimeBindings
}

/** One Agent node run on the persistent task volume: its run directory, helper-backed observations and material. */
export function openHostedTaskAgentRun(
  input: HostedTaskRunSelectionInput,
  run: {
    readonly binding: Pick<TaskRunFamilyBinding, 'nodeRunPrompts' | 'portArtifacts'>
    readonly physical: { readonly businessTaskId: string }
    readonly participants: HostedAgentParticipants
  },
  scope: TaskAgentRunScope,
): TaskAgentRunPurpose {
  const location = input.locate(scope.workspaceRef)
  const runPath = `/work/runs/${scope.taskId}/${scope.nodeRunId}`
  const workspace: AgentMaterialWorkspace = {
    workspace: { owner: 'source-control', reference: scope.workspaceRef, version: null },
    runContent: {
      owner: 'runtime-management',
      reference: input.reference(location.taskId, runPath),
      version: null,
    },
    retainedRef: input.reference(location.taskId, runPath),
    async prepare(seeds = []) {
      await input.helper.call(
        scope.taskId,
        'write-seeds',
        { path: runPath, files: seeds },
        { operationId: `agent-content:${scope.nodeRunId}` },
      )
    },
    // Runs and sessions share the persistent task volume. Cleanup is
    // owned by task retention, not by a detached service process.
    discard: async () => undefined,
  }
  return {
    invocationId: `hosted-agent:${scope.nodeRunId}`,
    nodeRunPrompts: run.binding.nodeRunPrompts,
    portArtifacts: run.binding.portArtifacts,
    workspace,
    outputWorkspaceRef: scope.workspaceRef,
    gitControlObservation: {
      capture: () => input.helper.call(location.taskId, 'git-control', { path: location.path }),
    },
    outputValidation: {
      resolve: (request) =>
        input.helper.call(location.taskId, 'validate-output', {
          rawContent: request.rawContent,
          kind: request.kind,
          port: request.port,
          worktreePath: input.locate(request.workspaceRef).path,
        }),
    },
    selectMaterial() {
      const preparation = createHostedAgentInvocationPreparation({
        ...input,
        participants: run.participants,
        taskId: scope.taskId,
        businessTaskId: run.physical.businessTaskId,
        cwd: location.path,
        workspace,
        async skillFiles(skill) {
          // Project skills are discovered from cwd by the native
          // CLI, as in standalone; only managed skills are staged.
          if (skill.sourceKind === 'project') return []
          if (skill.skillId === undefined || skill.contentVersion === undefined)
            throw new Error('hosted-skill-version-required')
          const files = await input.skills.readTree({
            id: skill.skillId,
            name: skill.name,
            contentVersion: skill.contentVersion,
          })
          return files.map((file) => ({
            path: `${skill.name}/${file.path}`,
            bytes: file.bytes,
          }))
        },
      })
      return createTaskAgentMaterialPreparation({
        preparation,
        resources: {
          injection: scope.material,
          runtimeBinding: scope.runtimeBinding,
          prepareMounts: () =>
            scope.taskMountRefs().map((reference) => ({
              owner: 'source-control',
              reference,
              version: null,
            })),
        },
        diagnostics: {
          readDeclaredMcpServers: (compiled) => compiled.declared.mcpServers,
          reportSpawn: (_compiled, log, details) => {
            log.info('crewstation agent execution', {
              ...details,
              businessTaskId: run.physical.businessTaskId,
            })
          },
          detectPluginLoadFailure: () => null,
        },
      })
    },
    bindExecutionParticipants: run.participants.bind,
  }
}
