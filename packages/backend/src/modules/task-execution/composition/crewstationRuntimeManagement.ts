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

/** A hosted probe answers one synchronous request. The system workspace's
 * provisioning (tens of seconds when its parent is created) and the smoke
 * turn (platform admission, the Agent container start, then the model) share
 * this budget, which stays below the HTTP server's 255 s idle timeout and the
 * UI's 300 s request deadline; the turn gets what provisioning left. A fixed
 * turn budget overran: the local 60 s first (RFC-370 hosted acceptance,
 * 2026-10-18), then 180 s counted after ~43 s of provisioning ended 3 s
 * before the turn's successful result (2026-10-19, a 166 s turn on the
 * acceptance cluster). */
export const HOSTED_RUNTIME_PROBE_BUDGET_MS = 240_000

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
        smoke: (request) =>
          smoke.run({
            ...request,
            timeoutMs: HOSTED_RUNTIME_PROBE_BUDGET_MS,
            deadlineAt: Date.now() + HOSTED_RUNTIME_PROBE_BUDGET_MS,
          }),
      }),
    })
  }
}
