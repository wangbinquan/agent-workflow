import type { DbClient } from '@/db/client'
import { ExecutionContractService } from './application/executionContractService'
import {
  createExecutionContractProgramFixtureAdapter,
  createExecutionContractResourceAdapter,
} from './infrastructure/taskExecutionAdapter'
import type {
  ExecutionContractParticipant,
  ExecutionContractProjectionParticipant,
  ExecutionContractRegistration,
} from './public/types'

export function composeExecutionContract(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly registrations: readonly ExecutionContractRegistration[]
  readonly implicitAgentDeclarations?: (input: {
    readonly frontmatterExtra: Readonly<Record<string, unknown>>
  }) => readonly { readonly contractId: string; readonly version: number }[]
}): ExecutionContractParticipant & ExecutionContractProjectionParticipant {
  const service = new ExecutionContractService({
    registrations: input.registrations,
    resources: createExecutionContractResourceAdapter(input.db, input.implicitAgentDeclarations),
    programFixtures: createExecutionContractProgramFixtureAdapter({ appHome: input.appHome }),
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
