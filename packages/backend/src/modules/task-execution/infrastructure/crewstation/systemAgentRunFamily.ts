// RFC-422 — the hosted (CrewStation) system agent run family's opener, moved from
// composition/crewstationSystemAgentRunFamily.ts: the hosted contents' release judgment, the invocation id (derived
// from the observation demand when there is one), the observation, the intent and the hosted preparation. The
// runtime-management contents arrive from the composition through the hosted provider port.
import { randomUUID } from 'node:crypto'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import { sha256Hex } from '@/util/hash'
import type { SystemAgentObservationFactory } from '../../application/ports/systemAgentObservation'
import type { SystemAgentRunFamily } from '../../application/ports/systemAgentRunFamily'
import { createSystemAgentRunFamily } from '../../application/systemAgentRun'
import { createHostedAgentInvocationPreparation } from './agentInvocationPreparation'
import type {
  HostedRunFamilyInput,
  HostedSystemAgentContentsFactory,
} from './hostedRunFamilyProviders'

/** All System Agent callers reuse the same core and normalized remote invocation. */
export function createHostedSystemAgentRunFamily(
  input: HostedRunFamilyInput,
  options: { readonly observations?: () => SystemAgentObservationFactory },
  providers: { readonly contents: HostedSystemAgentContentsFactory },
): SystemAgentRunFamily {
  const contents = providers.contents({
    ...input,
    async canRelease(taskId, invocationId, path) {
      const execution = await input.executions.find(`agent:${taskId}:system:${invocationId}`)
      return (
        (execution === null || execution.state === 'settled') &&
        (await input.executions.workspaceSettled(taskId, path))
      )
    },
  })
  return createSystemAgentRunFamily({
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
}
