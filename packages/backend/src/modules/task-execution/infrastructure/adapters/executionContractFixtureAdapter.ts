import type {
  ProgramToolSource,
  ScriptFixtureProcess,
  ScriptFixtureRunner,
} from '../../application/ports/scriptFixture'
import { createFileProgramToolSource } from '../local/fileProgramToolSource'
import { createLocalScriptFixtureProcess } from '../local/localScriptFixtureProcess'

/** The fixture's own run budget (the contract check is a single bounded run). */
const FIXTURE_TIMEOUT_MS = 30_000

/**
 * RFC-370 §10 V19: the program comes from the program store the deployment
 * selected and runs wherever the deployment runs scripts. A standalone daemon
 * defaults to the application home and this host's interpreters; a hosted one
 * reads platform objects and runs the fixture in the task image.
 */
export function createScriptFixtureRunner(input: {
  readonly appHome?: string
  readonly programs?: ProgramToolSource
  readonly process?: ScriptFixtureProcess
  readonly scriptInterpreterOverrides?: Partial<Record<'bash' | 'node' | 'python', string>>
}): ScriptFixtureRunner {
  const programs =
    input.programs ??
    (input.appHome === undefined ? undefined : createFileProgramToolSource(input.appHome))
  if (programs === undefined)
    throw new Error('script fixture runner requires a program source or the application home')
  const process =
    input.process ??
    createLocalScriptFixtureProcess(
      input.scriptInterpreterOverrides === undefined
        ? {}
        : { scriptInterpreterOverrides: input.scriptInterpreterOverrides },
    )
  return {
    async run({ implementation, inputJson }) {
      const program = await programs.read(implementation)
      if (program.kind === 'failed') return { kind: 'failed', checks: [program.check] }
      const outcome = await process.run({
        runtimeKind: implementation.runtimeKind,
        source: program.source,
        parameterValuesJson: program.parameterValuesJson,
        inputJson,
        timeoutMs: FIXTURE_TIMEOUT_MS,
      })
      if (outcome.kind === 'interpreter-unavailable')
        return {
          kind: 'failed',
          checks: [
            {
              code: 'program-interpreter-available',
              ok: false,
              detail: implementation.runtimeKind,
            },
          ],
        }
      if (outcome.kind === 'failed')
        return {
          kind: 'failed',
          checks: [
            {
              code: 'program-fixture-execution',
              ok: false,
              detail: `${outcome.failureCode}: ${outcome.stderrTail.slice(-1_000)}`,
            },
          ],
        }
      return { kind: 'completed', rawStdout: outcome.rawStdout }
    },
  }
}
