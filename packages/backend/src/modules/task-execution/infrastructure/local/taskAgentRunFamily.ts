// RFC-422 — the local task agent run family's opener, moved from composition/localTaskAgentRunFamily.ts: one run's
// purpose (workspace contents, output validation and port artifact mapping, the lazily bound material workspace, git
// control observation, material selection with its reference checks, the local preparation and the spawn
// diagnostics). The runtime-management, source-control and resource-catalog providers arrive from the composition
// through the native provider ports.
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { TaskAgentRunFamily } from '../../application/ports/taskAgentRunFamily'
import type { TaskAgentRunPurpose } from '../../application/ports/taskAgentMaterial'
import type { NodeRunPromptOperations } from '../../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../../application/ports/portArtifactContent'
import type {
  PortOutputContentValidation,
  PortOutputValidationContent,
} from '../../application/ports/portOutputValidation'
import { createTaskAgentMaterialPreparation } from '../../application/taskAgentMaterialPreparation'
import { createLocalAgentInvocationPreparation } from './agentInvocationPreparation'
import { bindLocalAgentExecutionParticipants } from './agentExecutionEffect'
import { broadcastNodeStatus } from '../nodeStatusEvents'
import { createFilePortOutputValidationContent } from './filePortOutputValidation'
import type {
  NativeGitControlObservation,
  NativeMaterialDefinitions,
  NativeMaterialWorkspace,
  NativeMaterialWorkspaces,
  NativePluginLoadFailures,
  NativeTaskAgentMaterialReferences,
  NativeTaskAgentRuntimes,
  NativeTaskAgentWorkspaceContentsFactory,
} from './nativeRunFamilyProviders'

/** The facts the opener reads from the native root's selection. */
export interface LocalTaskAgentRunFamilyInput {
  readonly appHome: string
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly binaryOverride?: readonly string[]
}

/** Native bootstrap facts stay at the local composition boundary. Normal
 * Task consumers receive only complete families and owner content references. */
export function createLocalTaskAgentRunFamily(
  input: LocalTaskAgentRunFamilyInput,
  providers: {
    readonly runtimes: NativeTaskAgentRuntimes
    readonly resources: NativeTaskAgentMaterialReferences
    readonly workspaceContents: NativeTaskAgentWorkspaceContentsFactory
    readonly gitControlObservation: NativeGitControlObservation
    readonly materialWorkspaces: NativeMaterialWorkspaces
    readonly materialDefinitions: NativeMaterialDefinitions
    /** RFC-491: the runtime's plugin-load failure judgment (runtime-management). */
    readonly pluginLoadFailures: NativePluginLoadFailures
    readonly outputValidation: (content: PortOutputValidationContent) => PortOutputContentValidation
  },
): TaskAgentRunFamily {
  const runtimes = providers.runtimes
  const resources = providers.resources
  return Object.freeze<TaskAgentRunFamily>({
    runtimeBindings: runtimes.bindings,
    materialReferences: resources.references,
    open(scope) {
      const workspaces = providers.workspaceContents({
        workspaceRef: () => scope.workspaceRef,
        taskMountRefs: () => scope.taskMountRefs(),
      })
      let materialWorkspace: NativeMaterialWorkspace
      const localOutput = createFilePortOutputValidationContent()
      const outputValidation = providers.outputValidation({
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
          materialWorkspace = providers.materialWorkspaces({
            kind: 'task',
            appHome: input.appHome,
            taskId: scope.taskId,
            nodeRunId: scope.nodeRunId,
            workingDirectory: () => scope.workspaceRef,
          })
          workspaces.bindWorking(materialWorkspace.workspace.workspace)
          return materialWorkspace.workspace
        },
        gitControlObservation: providers.gitControlObservation({
          workingDirectory: () => scope.workspaceRef,
        }),
        get outputWorkspaceRef() {
          return materialWorkspace.workspace.workspace.reference
        },
        outputValidation,
        selectMaterial(runtime, workspace) {
          const definition = providers.materialDefinitions(runtime)
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
              evidence: definition.evidence,
              materialReference: definition.materialReference,
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
                return providers.pluginLoadFailures(
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
        status: { broadcastNodeStatus },
        bindExecutionParticipants: (participant) =>
          bindLocalAgentExecutionParticipants(participant),
      }
      return purpose
    },
  })
}
