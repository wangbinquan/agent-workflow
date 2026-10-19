// RFC-370 §10 V19 — digital employee program tools on the selected store and
// script host.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). A program tool's
// source is stored as a platform object when hosted, but the contract fixture
// (validate / publish) and the Reaction execution read `<appHome>/<ref>` and
// ran the fixture on the service container's interpreters, which it has none
// of: every hosted validation failed `program-artifact-readable` and publish
// threw `employee-tool-contract-invalid`. These tests lock:
// - the fixture runner reads the program through `ProgramToolSource` and runs
//   it through `ScriptFixtureProcess`, keeping the check codes;
// - the hosted process runs the fixture as one task-image command in the
//   release-following `system:shared` volume, and a failed command is a failed
//   fixture run, not a crashed validation;
// - the task-image command runs the same local fixture process inside the
//   volume;
// - every root reads programs from the selected store (source assertion).
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScriptFixtureRunner } from '@/modules/task-execution/infrastructure/adapters/executionContractFixtureAdapter'
import { createArtifactProgramToolSource } from '@/modules/task-execution/infrastructure/adapters/programArtifactToolSource'
import { createHostedScriptFixtureProcess } from '@/modules/task-execution/infrastructure/crewstation/scriptFixtureProcess'
import { executeTaskImageExecutionOperation } from '@/modules/task-execution/composition/taskImageExecution'
import type {
  ScriptFixtureProcess,
  ScriptFixtureRun,
} from '@/modules/task-execution/application/ports/scriptFixture'

const implementation = {
  kind: 'program' as const,
  runtimeKind: 'node' as const,
  executableArtifactRef: 'aw-object:v2:employee-program-node:01M5:12:abc',
  executableDigest: 'abc',
  parameterValuesRef: 'aw-object:v2:employee-program-params:01M6:7:def',
  runtimeProfileRef: { id: 'profile', revision: 1 },
}

function storeWith(
  program: { source: string; parameterValues: Record<string, string> | null } | null,
) {
  const reads: unknown[] = []
  return {
    reads,
    source: createArtifactProgramToolSource({
      read: async (input) => {
        reads.push(input)
        return program
      },
    }),
  }
}

test('a hosted program is read from the selected store and run by the selected script host', async () => {
  const store = storeWith({ source: 'console.log("ok")', parameterValues: { mode: 'fast' } })
  const runs: ScriptFixtureRun[] = []
  const process: ScriptFixtureProcess = {
    run: async (run) => {
      runs.push(run)
      return { kind: 'completed', rawStdout: 'envelope' }
    },
  }
  const runner = createScriptFixtureRunner({ programs: store.source, process })
  expect(await runner.run({ implementation, inputJson: '{"a":1}' })).toEqual({
    kind: 'completed',
    rawStdout: 'envelope',
  })
  // The selected store receives the implementation as authoring hands it over.
  expect(store.reads).toEqual([implementation])
  expect(runs).toEqual([
    {
      runtimeKind: 'node',
      source: 'console.log("ok")',
      parameterValuesJson: '{"mode":"fast"}',
      inputJson: '{"a":1}',
      timeoutMs: 30_000,
    },
  ])
})

test('the fixture checks keep their codes on the selected store and host', async () => {
  const neverRuns: ScriptFixtureProcess = {
    run: async () => {
      throw new Error('a program that could not be read must not run')
    },
  }
  expect(
    await createScriptFixtureRunner({ programs: storeWith(null).source, process: neverRuns }).run({
      implementation,
      inputJson: '{}',
    }),
  ).toMatchObject({ kind: 'failed', checks: [{ code: 'program-artifact-readable', ok: false }] })
  const program = storeWith({ source: 'x', parameterValues: null }).source
  const unavailable = createScriptFixtureRunner({
    programs: program,
    process: { run: async () => ({ kind: 'interpreter-unavailable' }) },
  })
  expect(await unavailable.run({ implementation, inputJson: '{}' })).toEqual({
    kind: 'failed',
    checks: [{ code: 'program-interpreter-available', ok: false, detail: 'node' }],
  })
  const failing = createScriptFixtureRunner({
    programs: program,
    process: {
      run: async () => ({
        kind: 'failed',
        failureCode: 'script-timeout',
        stderrTail: 'last stderr',
      }),
    },
  })
  expect(await failing.run({ implementation, inputJson: '{}' })).toEqual({
    kind: 'failed',
    checks: [
      { code: 'program-fixture-execution', ok: false, detail: 'script-timeout: last stderr' },
    ],
  })
})

test('the hosted fixture runs as one task-image command in the release-following system volume', async () => {
  const calls: { owner: string; operation: string; input: unknown; options: unknown }[] = []
  const process = createHostedScriptFixtureProcess({
    helper: {
      call: async <T>(owner: string, operation: string, input: unknown, options?: unknown) => {
        calls.push({ owner, operation, input, options })
        return { kind: 'completed', rawStdout: 'out' } as T
      },
    },
  })
  const run: ScriptFixtureRun = {
    runtimeKind: 'bash',
    source: 'echo hi',
    parameterValuesJson: '{}',
    inputJson: '{}',
    timeoutMs: 30_000,
  }
  expect(await process.run(run)).toEqual({ kind: 'completed', rawStdout: 'out' })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    owner: 'system:shared',
    operation: 'execution-contract-fixture',
    input: run,
    options: { timeoutMs: 120_000 },
  })
  expect((calls[0]!.options as { operationId: string }).operationId).toStartWith(
    'execution-contract-fixture:',
  )
  const broken = createHostedScriptFixtureProcess({
    helper: {
      call: async () => {
        throw new Error('hosted-workspace-unavailable')
      },
    },
  })
  expect(await broken.run(run)).toEqual({
    kind: 'failed',
    failureCode: 'hosted-fixture-command-failed',
    stderrTail: 'hosted-workspace-unavailable',
  })
})

test('the task-image command runs the program on the image interpreter inside the volume', async () => {
  const volume = mkdtempSync(join(tmpdir(), 'aw-rfc370-fixture-volume-'))
  try {
    const outcome = (await executeTaskImageExecutionOperation(
      'execution-contract-fixture',
      {
        runtimeKind: 'bash',
        source: 'echo "params=$DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON"',
        parameterValuesJson: '{"mode":"fast"}',
        inputJson: '{}',
        timeoutMs: 30_000,
      } satisfies ScriptFixtureRun,
      undefined,
      volume,
    )) as { kind: string; rawStdout?: string }
    expect(outcome.kind).toBe('completed')
    expect(outcome.rawStdout).toContain('params={"mode":"fast"}')
  } finally {
    rmSync(volume, { recursive: true, force: true })
  }
}, 30_000)

test('every daemon root reads program tools from the selected store', () => {
  const core = readFileSync(
    join(import.meta.dir, '../src/modules/task-execution/composition/digitalEmployeeExecution.ts'),
    'utf8',
  )
  expect(core).toContain('deps.programs ?? createFileProgramToolSource(deps.appHome)')
  expect(core).not.toContain('readFileSync')
  const postgresql = readFileSync(
    join(import.meta.dir, '../src/cli/postgresqlDaemonApplication.ts'),
    'utf8',
  )
  expect(postgresql).toContain('createArtifactProgramToolSource(input.employeePrograms)')
  expect(postgresql).toContain('process: input.programFixtureProcess')
  const hosted = readFileSync(join(import.meta.dir, '../src/bootstrap/crewstation.ts'), 'utf8')
  expect(hosted).toContain('programFixtureProcess: createHostedScriptFixtureProcess(')
})
