import type { ExecutionContractProgramFixturePort } from '@/modules/execution-contract/composition/required-ports'
import type { ScriptFixtureRunner } from '../ports/scriptFixture'
/** Task supplies mechanism results; EC retains all output validation. */
export function createExecutionContractProgramFixturePort(
  runner: ScriptFixtureRunner,
): ExecutionContractProgramFixturePort {
  return { run: (input) => runner.run(input) }
}
