import type {
  ExecutionContractRegistration,
  ExecutionContractRef,
} from '@/modules/execution-contract/public/types'
import { executionContractGuideSchema } from '@/modules/execution-contract/domain/model'
import type { ExecutionContractProgramFixturePort } from '@/modules/execution-contract/composition/required-ports'

/** Simulated mechanism for authoring-only tests; EC still validates the real guide and pairing. */
export function exampleProgramFixture(
  registrations: readonly ExecutionContractRegistration[],
  contract: ExecutionContractRef,
): ExecutionContractProgramFixturePort {
  const registration = registrations.find(
    (r) =>
      r.contractRef.contractId === contract.contractId &&
      r.contractRef.version === contract.version,
  )
  if (!registration) throw new Error('missing test contract guide')
  const guide = executionContractGuideSchema.parse(JSON.parse(registration.guideJson))
  return {
    async run({ inputJson }) {
      const input = JSON.parse(inputJson) as Record<string, unknown>
      if (guide.outputMode === 'artifact-path')
        return { kind: 'completed', rawStdout: guide.output.exampleJson }
      const output = JSON.parse(guide.output.exampleJson) as Record<string, unknown>
      if (guide.inputMode === 'host-envelope') {
        output.roundRef = input.roundRef
        output.executionNonce = input.executionNonce
      }
      return { kind: 'completed', rawStdout: JSON.stringify(output) }
    },
  }
}
