// RFC-370 §10 V19 — a program tool's contract fixture runs in the task image.
//
// The service container has no script interpreters; a hosted validation or
// publication therefore failed every program tool. The fixture runs as one
// task-image command in the scratch volume of hosted system work, which
// follows the running release (so its helper knows the command), exactly as
// the MCP probe does.
import { ulid } from 'ulid'
import { z } from 'zod'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { ScriptFixtureProcess } from '../../application/ports/scriptFixture'

const OWNER = 'system:shared'
export const EXECUTION_CONTRACT_FIXTURE_OPERATION = 'execution-contract-fixture'
/** The fixture's own 30 s budget plus admission and helper start. */
export const HOSTED_FIXTURE_TIMEOUT_MS = 120_000

const Outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interpreter-unavailable') }),
  z.object({ kind: z.literal('failed'), failureCode: z.string(), stderrTail: z.string() }),
  z.object({ kind: z.literal('completed'), rawStdout: z.string() }),
])

export function createHostedScriptFixtureProcess(input: {
  readonly helper: WorkspaceHelper
}): ScriptFixtureProcess {
  return {
    async run(run) {
      try {
        return Outcome.parse(
          await input.helper.call(OWNER, EXECUTION_CONTRACT_FIXTURE_OPERATION, run, {
            operationId: `${EXECUTION_CONTRACT_FIXTURE_OPERATION}:${ulid()}`,
            timeoutMs: HOSTED_FIXTURE_TIMEOUT_MS,
          }),
        )
      } catch (error) {
        // A command that never produced the program's outcome is a failed
        // fixture run with its reason, not a crashed validation.
        return {
          kind: 'failed',
          failureCode: 'hosted-fixture-command-failed',
          stderrTail: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
