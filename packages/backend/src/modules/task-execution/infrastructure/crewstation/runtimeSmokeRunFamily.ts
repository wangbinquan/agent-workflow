// RFC-422 — the hosted (CrewStation) runtime probe, moved from composition/crewstationRuntimeManagement.ts: the hosted
// contents' release judgment, the smoke invocation (invocation id, shared system workspace, observation, hosted
// preparation and the smoke declaration) and the probe budget. The runtime-management contents arrive from the
// composition through the hosted provider port.
import { randomUUID } from 'node:crypto'
import type { RuntimeSmokeRunFamily } from '../../application/ports/runtimeSmoke'
import type { SystemAgentObservationFactory } from '../../application/ports/systemAgentObservation'
import {
  createRuntimeSmokeMaterialIntent,
  createRuntimeSmokeRunFamily,
} from '../../application/runtimeSmoke'
import { createHostedAgentInvocationPreparation } from './agentInvocationPreparation'
import type {
  HostedRunFamilyInput,
  HostedSystemAgentContentsFactory,
} from './hostedRunFamilyProviders'

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

/** One hosted runtime probe within the budget: provisioning and the smoke turn share it. */
export function createHostedRuntimeSmokeProbe(
  input: HostedRunFamilyInput,
  options: { readonly observations?: () => SystemAgentObservationFactory },
  providers: { readonly contents: HostedSystemAgentContentsFactory },
) {
  const contents = providers.contents({
    ...input,
    async canRelease(taskId, invocationId, path) {
      const execution = await input.executions.find(`agent:${taskId}:${invocationId}`)
      return (
        (execution === null || execution.state === 'settled') &&
        (await input.executions.workspaceSettled(taskId, path))
      )
    },
  })
  const smoke = createRuntimeSmokeRunFamily({
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
  return (request: Omit<Parameters<RuntimeSmokeRunFamily['run']>[0], 'timeoutMs' | 'deadlineAt'>) =>
    smoke.run({
      ...request,
      timeoutMs: HOSTED_RUNTIME_PROBE_BUDGET_MS,
      deadlineAt: Date.now() + HOSTED_RUNTIME_PROBE_BUDGET_MS,
    })
}
