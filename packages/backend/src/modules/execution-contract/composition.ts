import type { DbClient } from '@/db/client'
import { ExecutionContractService } from './application/executionContractService'
import type { ExecutionContractResourcePort } from './application/ports'
import {
  createExecutionContractProgramFixtureAdapter,
  createExecutionContractResourceAdapter,
} from './infrastructure/taskExecutionAdapter'
import type {
  ExecutionContractParticipant,
  ExecutionContractProjectionParticipant,
  ExecutionContractRegistration,
} from './public/types'

type ExecutionContractResourceComposition =
  | { readonly db: DbClient; readonly resources?: never }
  | { readonly db?: never; readonly resources: ExecutionContractResourcePort }

export function composeExecutionContract(
  input: ExecutionContractResourceComposition & {
    readonly appHome: string
    readonly registrations: readonly ExecutionContractRegistration[]
    readonly implicitAgentDeclarations?: (input: {
      readonly frontmatterExtra: Readonly<Record<string, unknown>>
    }) => readonly { readonly contractId: string; readonly version: number }[]
  },
): ExecutionContractParticipant & ExecutionContractProjectionParticipant {
  const resources =
    input.resources ??
    (input.db === undefined
      ? undefined
      : createExecutionContractResourceAdapter(input.db, input.implicitAgentDeclarations))
  if (resources === undefined) {
    throw new Error('execution-contract composition requires an injected resource port')
  }
  const service = new ExecutionContractService({
    registrations: input.registrations,
    resources,
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
