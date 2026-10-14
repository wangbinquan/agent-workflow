// RFC-371 v2 §4 — system-agent calls go through run-observability's single
// write contract (purpose `system`, kind from the caller's demand).

import { ulid } from 'ulid'
import type { CallObservations } from '@/modules/run-observability/public/participants'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'

export function composeSystemAgentObservations(input: {
  readonly calls: CallObservations
}): SystemAgentObservationFactory {
  return {
    async open(request) {
      const callId = ulid()
      const demand = request.demand
      const runtime = request.runtimeObservationIdentity
      return {
        callId,
        accept: () =>
          input.calls.accept({
            id: callId,
            purpose: 'system',
            taskId: demand?.parentTaskId ?? null,
            nodeRunId: null,
            systemKind: demand?.kind ?? request.feature,
            systemLabel: demand?.name ?? null,
            ownerUserId: demand?.ownerUserId ?? null,
            agentId: null,
            agentName: request.agentName,
            runtimeId: runtime?.registrationId ?? null,
            runtimeName: runtime?.acceptedName ?? null,
            protocol: request.protocol,
            startedAt: request.startedAt,
          }),
        usage: (snapshot) => input.calls.usage(callId, snapshot),
        finish: (outcome) => input.calls.finish(callId, outcome),
      }
    },
  }
}
