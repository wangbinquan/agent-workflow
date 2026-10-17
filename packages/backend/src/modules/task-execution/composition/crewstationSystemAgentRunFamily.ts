import { randomUUID } from 'node:crypto'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import { composeCrewStationSystemAgentContents } from '@/modules/runtime-management/composition/crewstationSystemAgentMaterial'
import { createLocalSystemAgentRuntimeBindings } from '@/modules/runtime-management/composition/systemAgentMaterial'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { createHostedAgentInvocationPreparation } from './crewstationAgentInvocation'
import { composeSystemAgentRunFamily } from './systemAgentRunFamily'
import { composeLocalSystemAgentRunFamily } from './localSystemAgentRunFamily'
import { sha256Hex } from '@/util/hash'

/** All System Agent callers reuse the same core and normalized remote invocation. */
export function createCrewStationSystemAgentRunFamily(
  input: Pick<
    Parameters<typeof createHostedAgentInvocationPreparation>[0],
    | 'db'
    | 'fence'
    | 'api'
    | 'executions'
    | 'profiles'
    | 'startupInventoryAvailable'
    | 'nativeConfigAvailable'
    | 'nativeModelMappingAvailable'
    | 'pluginFiles'
    | 'materialEnvironment'
  > & {
    readonly helper: WorkspaceHelper
    readonly reference: (taskId: string, path: string) => string
    readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
  },
): typeof composeLocalSystemAgentRunFamily {
  return (options) => {
    if (options.fixture !== undefined) return composeLocalSystemAgentRunFamily(options)
    const contents = composeCrewStationSystemAgentContents({
      ...input,
      async canRelease(taskId, invocationId, path) {
        const execution = await input.executions.find(`agent:${taskId}:system:${invocationId}`)
        return (
          (execution === null || execution.state === 'settled') &&
          (await input.executions.workspaceSettled(taskId, path))
        )
      },
    })
    // This compatibility binding only preserves profile getters; binary paths
    // are never resolved or executed on the service host.
    const runtimes = createLocalSystemAgentRuntimeBindings()
    const family = composeSystemAgentRunFamily({
      workspaces: contents.workspaces,
      retainedContents: contents.contents,
      invocations: {
        open(request, log) {
          const demand = request.observationDemand
          const invocationId =
            demand === undefined
              ? randomUUID()
              : sha256Hex(
                  JSON.stringify([
                    request.feature,
                    demand.kind,
                    demand.originalId,
                    demand.originalAttempt,
                  ]),
                )
          const selected = contents.open({
            scope: request.workspaceScope,
            invocationId,
            seeds: request.seedFiles,
          })
          return {
            workspace: selected.workspace,
            acknowledgeStart: () => true,
            prepareWorkspace: () => selected.workspace.prepare(),
            ...(options.observations
              ? {
                  observe: (startedAt: number) =>
                    options.observations!().open({
                      callId: `aw-hosted-system:${invocationId}`,
                      feature: request.feature,
                      agentName: request.agentName,
                      protocol: request.protocol,
                      startedAt,
                      ...(demand ? { demand } : {}),
                      ...(request.runtimeObservationIdentity
                        ? { runtimeObservationIdentity: request.runtimeObservationIdentity }
                        : {}),
                      ...(request.resumeSessionId
                        ? { resumeSessionId: request.resumeSessionId }
                        : {}),
                    }),
                }
              : {}),
            async compile() {
              const parent = await input.workspaces.ensure(selected.taskId)
              const profile = {
                model: request.model || null,
                variant: null,
                temperature: null,
                steps: null,
                maxSteps: null,
                isSandbox: request.isSandbox === true,
              }
              const intent: AgentMaterialIntent = {
                protocol: request.protocol,
                injection: { mcps: [], profile },
                prompt: request.prompt,
                agentName: request.agentName,
                systemPrompt: request.systemPrompt,
                resolvedProfiles: [[request.agentName, profile]],
                workspace: selected.workspace.workspace,
                runContent: selected.workspace.runContent,
                freshAgentRun: false,
                nodeRunId: `system:${invocationId}`,
                log,
                ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
              }
              return createHostedAgentInvocationPreparation({
                ...input,
                taskId: selected.taskId,
                businessTaskId: parent.businessTaskId,
                workspace: selected.workspace,
                cwd: selected.cwd,
                skillFiles: async () => {
                  throw new Error('system-persona-skill-content-unavailable')
                },
              }).compile(intent)
            },
          }
        },
      },
    })
    return Object.freeze({
      family,
      bindRuntime: runtimes.bindRuntime,
      withFixture: (runFn) => composeLocalSystemAgentRunFamily(options).withFixture(runFn),
    })
  }
}
