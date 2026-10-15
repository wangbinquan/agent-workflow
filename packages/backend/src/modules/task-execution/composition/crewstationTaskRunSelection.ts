import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  AgentMaterialWorkspace,
  TaskAgentRuntimeBindings,
} from '@/modules/runtime-management/public/participants'
import type { SkillPackageContentReader } from '@/modules/resource-catalog/public/participants'
import type { TaskAgentMaterialReferences } from '@/modules/resource-catalog/public/participants'
import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import type { TaskRunRootSelection } from './taskRunSelection'
import type { TaskRunFamilyBinding } from '../application/ports/taskRunSelection'
import { createTaskAgentMaterialPreparation } from './taskAgentMaterialPreparation'
import {
  createHostedAgentInvocationPreparation,
  bindHostedAgentExecutionParticipants,
  type HostedAgentProfile,
} from './crewstationAgentInvocation'
import { createHostedTaskScriptRunFamily } from '../infrastructure/crewstation/taskScriptRunFamily'
import type { HostedExecution } from '../infrastructure/crewstation/execution'

export function composeCrewStationTaskRunSelection(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly executions: HostedExecution
  readonly helper: WorkspaceHelper
  readonly profiles: readonly HostedAgentProfile[]
  readonly skills: SkillPackageContentReader
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
  readonly reference: (taskId: string, path: string) => string
  readonly runtimeBindingsFor: (
    binding: Pick<TaskRunFamilyBinding, 'nodeRunRuntime' | 'runtimeRegistry'>,
  ) => TaskAgentRuntimeBindings
}): TaskRunRootSelection {
  const materialReferences: TaskAgentMaterialReferences = {
    references(snapshot) {
      return {
        skills: snapshot.skills.map((skill) => ({
          name: skill.name,
          sourceKind: skill.kind,
          ...(skill.kind === 'managed'
            ? { skillId: skill.skillId, contentVersion: skill.contentVersion }
            : {}),
          content: {
            owner: 'resource-catalog',
            reference:
              skill.kind === 'managed'
                ? `hosted-skill:${skill.skillId}`
                : `project-skill:${skill.name}`,
            version: skill.kind === 'managed' ? skill.contentVersion : null,
          },
        })),
        plugins: snapshot.plugins.map((plugin) => ({
          declaration: {
            id: plugin.id,
            name: plugin.name,
            options: plugin.options,
            enabled: plugin.enabled,
          },
          content: {
            owner: 'resource-catalog',
            reference: `hosted-plugin:${plugin.id}`,
            version: plugin.resolvedVersion ?? null,
          },
        })),
      }
    },
  }
  return {
    configurationFor: () => ({ kind: 'task-run-configuration', reference: Object.freeze({}) }),
    runs: {
      contentNamespace: { kind: 'task-run-content-namespace', reference: Object.freeze({}) },
      nodeRunPrompts: input.nodeRunPrompts,
      portArtifacts: input.portArtifacts,
      async taskAgentRunsFor(binding) {
        const physical = await input.workspaces.ensure(binding.taskId)
        return {
          runtimeBindings: input.runtimeBindingsFor(binding),
          materialReferences,
          open(scope) {
            const location = input.locate(scope.workspaceRef)
            const runPath = `/work/runs/${scope.taskId}/${scope.nodeRunId}`
            const workspace: AgentMaterialWorkspace = {
              workspace: { owner: 'source-control', reference: scope.workspaceRef, version: null },
              runContent: {
                owner: 'runtime-management',
                reference: input.reference(scope.taskId, runPath),
                version: null,
              },
              retainedRef: input.reference(scope.taskId, runPath),
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
              nodeRunPrompts: binding.nodeRunPrompts,
              portArtifacts: binding.portArtifacts,
              workspace,
              outputWorkspaceRef: scope.workspaceRef,
              gitControlObservation: {
                capture: () =>
                  input.helper.call(location.taskId, 'git-control', { path: location.path }),
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
                  taskId: scope.taskId,
                  businessTaskId: physical.businessTaskId,
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
                    return files.map((file) => {
                      const content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
                      return { path: `${skill.name}/${file.path}`, content }
                    })
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
                    readDeclaredMcpServers: () => [],
                    reportSpawn: (_compiled, log, details) => {
                      log.info('crewstation agent execution', {
                        ...details,
                        businessTaskId: physical.businessTaskId,
                      })
                    },
                    detectPluginLoadFailure: () => null,
                  },
                })
              },
              bindExecutionParticipants: bindHostedAgentExecutionParticipants,
            }
          },
        }
      },
      taskScriptRunsFor: (binding) =>
        createHostedTaskScriptRunFamily({
          ...input,
          taskId: binding.taskId,
          path: (reference) => input.locate(reference).path,
        }),
    },
  }
}
