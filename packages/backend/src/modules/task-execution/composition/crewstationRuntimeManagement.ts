import { randomUUID } from 'node:crypto'
import {
  createCrewStationRuntimeManagementEffects,
  type HostedRuntimeCapabilities,
} from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import { composeRuntimeManagement } from '@/modules/runtime-management/composition/runtimeManagement'
import { composeCrewStationSystemAgentContents } from '@/modules/runtime-management/composition/crewstationSystemAgentMaterial'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { createHostedAgentInvocationPreparation } from './crewstationAgentInvocation'
import { composeRuntimeSmokeRunFamily } from './runtimeSmokeRunFamily'
import { createRuntimeSmokeMaterialIntent } from './runtimeSmoke'
import type { composeLocalRuntimeManagement } from './localRuntimeManagement'

export function createCrewStationRuntimeManagement(
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
    readonly initialCapabilities: HostedRuntimeCapabilities
    readonly capabilities: () => Promise<HostedRuntimeCapabilities>
  },
): typeof composeLocalRuntimeManagement {
  return (options) => {
    const contents = composeCrewStationSystemAgentContents({
      ...input,
      async canRelease(taskId, invocationId, path) {
        const execution = await input.executions.find(`agent:${taskId}:${invocationId}`)
        return (
          (execution === null || execution.state === 'settled') &&
          (await input.executions.workspaceSettled(taskId, path))
        )
      },
    })
    const smoke = composeRuntimeSmokeRunFamily({
      invocations: {
        open(request, log) {
          const invocationId = `smoke-${randomUUID()}`
          return {
            materialize() {
              const selected = contents.open({
                scope: contents.workspaces.capture({ namespace: 'shared' }),
                invocationId,
              })
              return {
                workspace: selected.workspace,
                prepareWorkspace: () => selected.workspace.prepare(),
                ...(options.observations
                  ? {
                      observe: (nonce: string, startedAt: number) =>
                        options.observations!().open({
                          callId: invocationId,
                          feature: 'runtime-smoke',
                          agentName: 'aw-smoke',
                          protocol: request.protocol,
                          startedAt,
                          demand: {
                            kind: 'runtime-probe',
                            originalId: nonce,
                            originalAttempt: nonce,
                            name: `运行时探测 · ${request.protocol}`,
                            purpose: 'system',
                          },
                          ...(request.runtimeObservationIdentity
                            ? { runtimeObservationIdentity: request.runtimeObservationIdentity }
                            : {}),
                        }),
                    }
                  : {}),
                async compile(prompt) {
                  const parent = await input.workspaces.ensure(selected.taskId)
                  const preparation = createHostedAgentInvocationPreparation({
                    ...input,
                    taskId: selected.taskId,
                    businessTaskId: parent.businessTaskId,
                    cwd: selected.cwd,
                    workspace: selected.workspace,
                    skillFiles: async () => {
                      throw new Error('smoke-skill-unavailable')
                    },
                  })
                  const intent = createRuntimeSmokeMaterialIntent(
                    { ...request, runtimeBinding: request.target.runtimeBinding },
                    preparation,
                    prompt,
                    log,
                  )
                  return preparation.compile({
                    ...intent,
                    nodeRunId: invocationId,
                    injection: { ...intent.injection, profile: intent.resolvedProfiles[0]![1] },
                  })
                },
              }
            },
          }
        },
      },
    })
    return composeRuntimeManagement({
      runtimeRegistry: options.runtimeRegistry,
      effects: createCrewStationRuntimeManagementEffects({
        ...input,
        configuration: options.configuration,
        runtimeTests: options.runtimeTests,
        smoke: (request) => smoke.run(request),
      }),
    })
  }
}
