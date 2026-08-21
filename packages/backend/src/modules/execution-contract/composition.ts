import type { DbClient } from '@/db/client'
import { ExecutionContractService } from './application/executionContractService'
import {
  createExecutionContractProgramFixtureAdapter,
  createExecutionContractResourceAdapter,
} from './infrastructure/taskExecutionAdapter'
import type { ExecutionContractParticipant, ExecutionContractRegistration } from './public/types'

export function composeExecutionContract(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly registrations: readonly ExecutionContractRegistration[]
  readonly implicitAgentDeclarations?: (input: {
    readonly frontmatterExtra: Readonly<Record<string, unknown>>
  }) => readonly { readonly contractId: string; readonly version: number }[]
}): ExecutionContractParticipant {
  const service = new ExecutionContractService({
    registrations: input.registrations,
    resources: createExecutionContractResourceAdapter(input.db, input.implicitAgentDeclarations),
    programFixtures: createExecutionContractProgramFixtureAdapter({ appHome: input.appHome }),
  })
  return {
    list: () => service.list(),
    get: (ref) => service.get(ref),
    validateExecutor: (request) => service.validateExecutor(request),
    validateAgentCandidates: (request) => service.validateAgentCandidates(request),
    validateEnvelope: (request) => service.validateEnvelope(request),
  }
}
