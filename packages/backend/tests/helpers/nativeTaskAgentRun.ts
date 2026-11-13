// RFC-491: moved from `src/modules/task-execution/infrastructure/local/` — only the RFC-370 contract tests use this
// native compatibility run (RFC-375 retained it for them; the architecture gate listed it as unreachable production
// code). Unchanged, with the relative imports written as aliases.
import { join } from 'node:path'
import { runNode as runTaskAgentCore } from '@/modules/task-execution/application/taskAgentRun'
import type { RunResult } from '@/modules/task-execution/application/ports/taskAgentRun'
import type {
  TaskAgentRunPurpose,
  TaskCompiledAgentInvocation,
} from '@/modules/task-execution/application/ports/taskAgentMaterial'
import type { RunNodeOptions } from './nativeTaskAgentRunOptions'
import { bindLocalAgentExecutionParticipants } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { broadcastNodeStatus } from '@/modules/task-execution/infrastructure/nodeStatusEvents'
import { detectPluginLoadFailure } from '@/modules/runtime-management/infrastructure/local/pluginLoadDiagnostics'
import { selectNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { selectPortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { resolveNativePortContentDetailed } from '@/modules/task-execution/infrastructure/local/filePortOutputValidation'
import { bindNativeAgentInvocation } from '@/modules/task-execution/infrastructure/local/agentInvocation'
import type { NativeMaterialDefinitions } from '@/modules/task-execution/infrastructure/local/nativeRunFamilyProviders'
import { bindNativeAgentWorkspaceGitControlObservation } from '@/modules/source-control/composition/agentWorkspaceGitControl'
import {
  bindNativeAgentMaterialWorkspace,
  getRuntimeDriver,
} from '@/modules/runtime-management/infrastructure/drivers'
import type { AgentSpawnPlan } from '@/modules/runtime-management/infrastructure/drivers/types'
import { resolveBoundaryMounts } from '@/modules/source-control/domain/taskAgentMounts'

/** RFC-489: the runtime-management providers the compatibility run receives (the caller binds them). */
export interface NativeTaskAgentRunProviders {
  /** The runtime's protocol, the run's evidence and the plan's material reference. */
  readonly materialDefinitions: NativeMaterialDefinitions
}

/** Explicit compatibility binding. Getters retain the original options reads
 * at their original core boundaries; creating the purpose performs no IO,
 * content selection, runtime lookup, compilation or command interpretation. */
export function bindNativeTaskAgentRunPurpose(
  opts: RunNodeOptions,
  providers: NativeTaskAgentRunProviders,
): TaskAgentRunPurpose {
  let materialWorkspace: ReturnType<typeof bindNativeAgentMaterialWorkspace>
  let runRoot: string
  return {
    get nodeRunPrompts() {
      return selectNodeRunPromptOperations(opts.nodeRunPrompts, join(opts.appHome, 'runs'))
    },
    get portArtifacts() {
      return selectPortArtifactOperations(opts.portArtifacts, opts.appHome)
    },
    get workspace() {
      materialWorkspace = bindNativeAgentMaterialWorkspace({
        kind: 'task',
        appHome: opts.appHome,
        taskId: opts.taskId,
        nodeRunId: opts.nodeRunId,
        workingDirectory: () => opts.worktreePath,
      })
      runRoot = materialWorkspace.locations.runDirectory
      return materialWorkspace.workspace
    },
    get gitControlObservation() {
      return bindNativeAgentWorkspaceGitControlObservation({
        workingDirectory: () => opts.worktreePath,
      })
    },
    get outputWorkspaceRef() {
      // The native compatibility dialect preserves this original late value.
      // The common core forwards it only to the selected content receiver.
      return opts.worktreePath
    },
    outputValidation: {
      async resolve({ workspaceRef, ...request }) {
        return resolveNativePortContentDetailed({ ...request, worktreePath: workspaceRef })
      },
    },
    selectMaterial(runtime) {
      const driver = getRuntimeDriver(runtime)
      const definition = providers.materialDefinitions(runtime)
      let boundaryMounts: string[]
      return {
        prepareMounts() {
          boundaryMounts = resolveBoundaryMounts(
            opts.worktreePath,
            (opts.templateMeta.repos ?? []).map((r) => r.worktreePath),
          )
        },
        async compile(declaration) {
          const plan: AgentSpawnPlan = await driver.buildSpawn({
            injection: {
              mcps: declaration.injection.mcps,
              agent: declaration.injection.agent,
              dependents: declaration.injection.dependents,
              plugins: opts.plugins ?? [],
              skills: opts.skills,
              ...('profile' in declaration.injection
                ? { profile: declaration.injection.profile }
                : {}),
            },
            prompt: declaration.prompt,
            agentName: declaration.agentName,
            systemPrompt: declaration.systemPrompt,
            injectedMemoryBlock: declaration.injectedMemoryBlock,
            resolvedParamsByAgent: new Map(declaration.resolvedProfiles),
            cwd: opts.worktreePath,
            runRoot,
            configDir: declaration.configDir,
            taskMounts: boundaryMounts,
            freshAgentRun: declaration.freshAgentRun,
            resumeSessionId: declaration.resumeSessionId,
            runtimeBinary: opts.runtimeBinary,
            ...(opts.binaryOverride !== undefined ? { binaryOverride: opts.binaryOverride } : {}),
            gitUserName: declaration.gitUserName,
            gitUserEmail: declaration.gitUserEmail,
            nodeRunId: declaration.nodeRunId,
            log: declaration.log,
          })
          let commandSnapshot: readonly string[]
          const compiled: TaskCompiledAgentInvocation = {
            bind() {
              const { cmd, env } = plan
              commandSnapshot = cmd
              const invocation = bindNativeAgentInvocation({
                plan,
                protocol: definition.protocol,
                workspace: materialWorkspace.workspace,
                workingDirectory: () => opts.worktreePath,
                taskSnapshot: { command: cmd, environment: env },
                requireSpawnReceipt: true,
                cleanupReceiver: 'material',
                // RFC-489: the evidence the invocation used to build from the driver hooks, over the same scope.
                get evidence() {
                  return definition.evidence({
                    environment: () => plan.env,
                    runContent: () => runRoot,
                    sessionLocation: () => ({
                      worktreePath: opts.worktreePath,
                      configDirEnv: declaration.configDir!.env,
                      configDirName: declaration.configDir!.name,
                    }),
                  })
                },
                materialReference: () => definition.materialReference(plan),
              })
              return invocation
            },
            readDeclaredMcpServers() {
              return plan.declaredMcpServers
            },
            reportSpawn(log, input) {
              log.info('spawning agent runtime', {
                runtime: input.runtime,
                bin: commandSnapshot[0],
                agent: input.agentName,
                cwd: opts.worktreePath,
                nodeRunId: input.nodeRunId,
                ...(plan.diagnostics ?? {}),
              })
            },
            detectPluginLoadFailure(line) {
              return detectPluginLoadFailure(line, opts.plugins ?? [])
            },
          }
          return compiled
        },
      }
    },
    status: { broadcastNodeStatus },
    bindExecutionParticipants(input) {
      return bindLocalAgentExecutionParticipants(input)
    },
  }
}

/** Every legacy caller uses the complete original Task algorithm. */
export async function runNativeTaskAgent(
  opts: RunNodeOptions,
  providers: NativeTaskAgentRunProviders,
): Promise<RunResult> {
  return runTaskAgentCore(opts, bindNativeTaskAgentRunPurpose(opts, providers))
}
