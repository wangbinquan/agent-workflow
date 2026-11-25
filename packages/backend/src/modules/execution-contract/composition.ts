import { ExecutionContractService } from './application/executionContractService'
import type {
  ExecutionContractResourcePort,
  ExecutionContractProgramFixturePort,
} from './composition/required-ports'
import type {
  ExecutionContractParticipant,
  ExecutionContractProjectionParticipant,
  ExecutionContractRegistration,
} from './public/types'

export function composeExecutionContract(input: {
  readonly resources: ExecutionContractResourcePort
  readonly programFixtures: ExecutionContractProgramFixturePort
  readonly registrations: readonly ExecutionContractRegistration[]
}): ExecutionContractParticipant & ExecutionContractProjectionParticipant {
  const service = new ExecutionContractService({
    registrations: input.registrations,
    resources: input.resources,
    programFixtures: input.programFixtures,
  })
  return {
    list: () => service.list(),
    get: (ref) => service.get(ref),
    projectInput: (request) => service.projectInput(request),
    validateExecutor: (request) => service.validateExecutor(request),
    validateAgentCandidates: (request) => service.validateAgentCandidates(request),
    validateEnvelope: (request) => service.validateEnvelope(request),
  }
}

// RFC-577: the HTTP binding lives in this module's inbound layer; server.ts mounts it through here.
export { mountExecutionContractRoutes } from './inbound/http/executionContractRoutes'
