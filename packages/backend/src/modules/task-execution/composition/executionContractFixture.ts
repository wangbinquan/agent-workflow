import { createScriptFixtureRunner } from '../infrastructure/adapters/executionContractFixtureAdapter'
import { createExecutionContractProgramFixturePort } from '../application/adapters/execution-contract-adapter'
export function createExecutionContractProgramFixtureAdapter(
  input: Parameters<typeof createScriptFixtureRunner>[0],
) {
  return createExecutionContractProgramFixturePort(createScriptFixtureRunner(input))
}
