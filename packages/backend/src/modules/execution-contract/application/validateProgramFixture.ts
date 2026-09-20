import { ulid } from 'ulid'
import { sha256Hex } from '@/util/hash'
import {
  validateExactContractOutput,
  type ExecutionContractGuide,
  type ExecutionContractCheck,
  type ExecutionContractImplementation,
} from '../domain/model'
import type { ExecutionContractProgramFixturePort } from '../composition/required-ports'

export async function validateProgramFixture(input: {
  readonly guide: ExecutionContractGuide
  readonly implementation: Extract<ExecutionContractImplementation, { kind: 'program' }>
  readonly fixtures: ExecutionContractProgramFixturePort
  readonly validateOutputJson?: (outputJson: string) => string
}): Promise<readonly ExecutionContractCheck[]> {
  const { guide, implementation, validateOutputJson } = input
  const roundRef = `fixture-${ulid()}`
  const executionNonce = sha256Hex(roundRef)
  const fixtureInput = JSON.parse(guide.input.exampleJson) as Record<string, unknown>
  if (guide.inputMode === 'host-envelope') {
    fixtureInput.roundRef = roundRef
    fixtureInput.executionNonce = executionNonce
  }
  const outcome = await input.fixtures.run({
    implementation,
    inputJson: JSON.stringify(fixtureInput),
  })
  if (outcome.kind === 'failed') return outcome.checks
  try {
    const rawOutput = outcome.rawStdout.trim()
    const outputJson =
      guide.outputMode === 'direct-json' ? validateOutputJson?.(rawOutput) : rawOutput
    if (outputJson === undefined)
      throw new Error('direct JSON output contract has no registered validator')
    validateExactContractOutput({ guide, roundRef, executionNonce, outputJson })
    return [
      {
        code: 'program-fixture-exact-output',
        ok: true,
        detail: `${guide.input.schemaId} -> ${guide.output.schemaId}`,
      },
    ]
  } catch (error) {
    return [
      {
        code: 'program-fixture-exact-output',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    ]
  }
}
