import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import {
  bindNativeAgentMaterialWorkspace,
  selectLocalAgentMaterialDefinition,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import { composeLocalTaskAgentRuntimeBindings } from '@/modules/runtime-management/composition/taskAgentRuntimeBindings'
import { composeLocalTaskAgentMaterialReferences } from '@/modules/resource-catalog/composition/taskAgentMaterialReferences'
import { composeLocalTaskAgentWorkspaceContents } from '@/modules/source-control/composition/taskAgentWorkspaceContents'
import { bindNativeAgentWorkspaceGitControlObservation } from '@/modules/source-control/composition/agentWorkspaceGitControl'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskAgentRunPurpose } from '../application/ports/taskAgentMaterial'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import { createLocalAgentInvocationPreparation } from './localAgentInvocationPreparation'
import { createTaskAgentMaterialPreparation } from './taskAgentMaterialPreparation'
import {
  composePortOutputContentValidation,
  createNativePortOutputValidationContent,
} from './portOutputValidation'
import { bindLocalAgentExecutionParticipants } from '../infrastructure/local/agentExecutionEffect'
import { detectPluginLoadFailure } from '../infrastructure/local/nativeTaskAgentPluginLoadDiagnostics'
import { freezeBinaryConfig } from '@/services/execution/runtimeConfigFreeze'

/** Binding input used only at bootstrap's native composition boundary. */
export interface LocalTaskAgentRunFamilyBinding {
  readonly request: {
    readonly appHome: string
    readonly binaryOverride?: readonly string[]
    readonly configPath?: string
    readonly operationConfiguration?: TaskOperationConfigurationQueries
  }
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly operationConfiguration?: TaskOperationConfigurationQueries
}

/** Explicit local family selection shared by production and fixture roots. */
export function composeLocalTaskAgentRunFamilyFor(
  binding: LocalTaskAgentRunFamilyBinding,
): TaskAgentRunFamily {
  const operationConfiguration =
    binding.operationConfiguration === undefined
      ? binding.request.operationConfiguration
      : binding.operationConfiguration
  return composeLocalTaskAgentRunFamily({
    appHome: binding.request.appHome,
    ...(binding.request.binaryOverride === undefined
      ? {}
      : { binaryOverride: binding.request.binaryOverride }),
    ...(binding.request.configPath === undefined ? {} : { configPath: binding.request.configPath }),
    nodeRunRuntime: binding.nodeRunRuntime,
    runtimeRegistry: binding.runtimeRegistry,
    nodeRunPrompts: binding.nodeRunPrompts,
    portArtifacts: binding.portArtifacts,
    ...(operationConfiguration === undefined ? {} : { operationConfiguration }),
  })
}

/** Native bootstrap facts stay at the local composition boundary. Normal
 * Task consumers receive only complete families and owner content references. */
export function composeLocalTaskAgentRunFamily(input: {
  readonly appHome: string
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly operationConfiguration?: TaskOperationConfigurationQueries
}): TaskAgentRunFamily {
  const runtimes = composeLocalTaskAgentRuntimeBindings({
    persistence: input.nodeRunRuntime,
    registry: input.runtimeRegistry,
    readBinaryConfiguration: () =>
      freezeBinaryConfig(input.configPath, input.operationConfiguration),
  })
  const resources = composeLocalTaskAgentMaterialReferences({ appHome: input.appHome })
  return Object.freeze<TaskAgentRunFamily>({
    runtimeBindings: runtimes.bindings,
    materialReferences: resources.references,
    open(scope) {
      const workspaces = composeLocalTaskAgentWorkspaceContents({
        workspaceRef: () => scope.workspaceRef,
        taskMountRefs: () => scope.taskMountRefs(),
      })
      let materialWorkspace: ReturnType<typeof bindNativeAgentMaterialWorkspace>
      const localOutput = createNativePortOutputValidationContent()
      const outputValidation = composePortOutputContentValidation({
        resolve(workspaceRef, rawContent) {
          return localOutput.resolve(workspaces.workingDirectory(workspaceRef), rawContent)
        },
        readUtf8(targetRef) {
          return localOutput.readUtf8(targetRef)
        },
      })
      const portArtifacts: PortArtifactOperations = Object.freeze<PortArtifactOperations>({
        archive(request) {
          return input.portArtifacts.archive({
            ...request,
            items: request.items.map((item) => ({
              ...item,
              source: {
                ...item.source,
                workspaceRef: workspaces.workingDirectory(item.source.workspaceRef),
              },
            })),
          })
        },
        read(request) {
          return input.portArtifacts.read({
            ...request,
            fallbackWorkspaceRef:
              request.fallbackWorkspaceRef === null
                ? null
                : workspaces.workingDirectory(request.fallbackWorkspaceRef),
          })
        },
      })
      const purpose: TaskAgentRunPurpose = {
        nodeRunPrompts: input.nodeRunPrompts,
        portArtifacts,
        get workspace() {
          materialWorkspace = bindNativeAgentMaterialWorkspace({
            kind: 'task',
            appHome: input.appHome,
            taskId: scope.taskId,
            nodeRunId: scope.nodeRunId,
            workingDirectory: () => scope.workspaceRef,
          })
          workspaces.bindWorking(materialWorkspace.workspace.workspace)
          return materialWorkspace.workspace
        },
        gitControlObservation: bindNativeAgentWorkspaceGitControlObservation({
          workingDirectory: () => scope.workspaceRef,
        }),
        get outputWorkspaceRef() {
          return materialWorkspace.workspace.workspace.reference
        },
        outputValidation,
        selectMaterial(runtime, workspace) {
          const definition = selectLocalAgentMaterialDefinition(runtime)
          const material = definition.createCompiler(
            {
              workspace: (reference) => workspaces.workspace(reference),
              runContent(reference) {
                if (reference !== workspace.runContent)
                  throw new Error('task-agent-run-content-reference-unavailable')
                return materialWorkspace.locations.runDirectory
              },
              runtimeBinary: (reference) => runtimes.contents.runtimeBinary(reference),
              skill: (reference) => resources.contents.skill(reference),
              plugin: (reference) => resources.contents.plugin(reference),
            },
            input.binaryOverride === undefined
              ? undefined
              : { binaryOverride: input.binaryOverride },
          )
          let configDir: AgentMaterialIntent['configDir']
          let commandSnapshot: readonly string[]
          const preparation = createLocalAgentInvocationPreparation({
            material,
            binding: {
              protocol: definition.protocol,
              workspace,
              workingDirectory: () => scope.workspaceRef,
              requireSpawnReceipt: true,
              cleanupReceiver: 'material',
              evidenceHooks: definition.evidenceHooks,
            },
            evidenceScope: {
              runContent: () => materialWorkspace.locations.runDirectory,
              sessionLocation: () => ({
                worktreePath: scope.workspaceRef,
                configDirEnv: configDir!.env,
                configDirName: configDir!.name,
              }),
            },
            taskSnapshot: true,
            onTaskSnapshot(snapshot) {
              commandSnapshot = snapshot.command
            },
          })
          const selected = createTaskAgentMaterialPreparation({
            preparation,
            resources: {
              injection: scope.material,
              runtimeBinding: scope.runtimeBinding,
              prepareMounts: () => workspaces.prepareMounts(),
            },
            diagnostics: {
              readDeclaredMcpServers(compiled) {
                return material.nativePlan(compiled.materialRef).declaredMcpServers
              },
              reportSpawn(compiled, log, details) {
                const plan = material.nativePlan(compiled.materialRef)
                log.info('spawning agent runtime', {
                  runtime: details.runtime,
                  bin: commandSnapshot[0],
                  agent: details.agentName,
                  cwd: scope.workspaceRef,
                  nodeRunId: details.nodeRunId,
                  ...(plan.diagnostics ?? {}),
                })
              },
              detectPluginLoadFailure(_compiled, line) {
                return detectPluginLoadFailure(
                  line,
                  scope.material.plugins.map((plugin) => resources.contents.plugin(plugin)),
                )
              },
            },
          })
          return {
            prepareMounts: () => selected.prepareMounts(),
            compile(declaration) {
              configDir = declaration.configDir
              return selected.compile(declaration)
            },
          }
        },
        bindExecutionParticipants: (participant) =>
          bindLocalAgentExecutionParticipants(participant),
      }
      return purpose
    },
  })
}
