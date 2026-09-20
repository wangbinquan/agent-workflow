// RFC-361: resource/program execution moves to its owner; EC retains the pairing,
// validator return value and exact output oracle. The real Script runner remains the mechanism.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateProgramFixture } from '@/modules/execution-contract/application/validateProgramFixture'
import {
  executionContractGuideSchema,
  type ExecutionContractGuide,
  type ExecutionContractImplementation,
} from '@/modules/execution-contract/domain/model'
import { developmentExecutionContractRegistrations } from '@/modules/development-automation/composition/employeeTypePackage'
import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
import { createProgramArtifactStore } from '@/modules/digital-employee/infrastructure/programArtifactStore'
import { sha256Hex } from '@/util/hash'

const registration = developmentExecutionContractRegistrations.find(
  (r) => r.contractRef.contractId === 'development.prepare-materials',
)!
const guide = executionContractGuideSchema.parse(JSON.parse(registration.guideJson))
const implementation: Extract<ExecutionContractImplementation, { kind: 'program' }> = {
  kind: 'program',
  runtimeKind: 'node',
  executableArtifactRef: 'fixture.js',
  executableDigest: 'unused',
  parameterValuesRef: null,
  runtimeProfileRef: { id: 'unchanged-profile-ref', revision: 7 },
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function directGuide(): ExecutionContractGuide {
  return {
    ...guide,
    inputMode: 'direct-json',
    outputMode: 'direct-json',
    output: {
      ...guide.output,
      topLevelFields: ['summary'],
      fields: guide.output.fields.filter((f) => f.path === 'summary'),
      exampleJson: '{"summary":"example"}',
    },
  }
}

describe('RFC-361 EC-owned program validation', () => {
  test('materializes the host pairing and passes only the implementation and input to Task', async () => {
    expect(guide.inputMode).toBe('host-envelope')
    const checks = await validateProgramFixture({
      guide,
      implementation,
      fixtures: {
        async run(request) {
          expect(Object.keys(request).sort()).toEqual(['implementation', 'inputJson'])
          expect(request.implementation).toBe(implementation)
          const input = JSON.parse(request.inputJson)
          expect(input.roundRef).toStartWith('fixture-')
          expect(input.executionNonce).toBe(sha256Hex(input.roundRef))
          const output = JSON.parse(guide.output.exampleJson)
          return {
            kind: 'completed',
            rawStdout:
              ' \n' +
              JSON.stringify({
                ...output,
                roundRef: input.roundRef,
                executionNonce: input.executionNonce,
              }) +
              '\n ',
          }
        },
      },
    })
    expect(checks).toEqual([
      {
        code: 'program-fixture-exact-output',
        ok: true,
        detail: `${guide.input.schemaId} -> ${guide.output.schemaId}`,
      },
    ])
  })
  test('rejects a mismatched pairing after a successful process', async () => {
    const checks = await validateProgramFixture({
      guide,
      implementation,
      fixtures: {
        async run() {
          return { kind: 'completed', rawStdout: guide.output.exampleJson }
        },
      },
    })
    expect(checks).toEqual([
      expect.objectContaining({ code: 'program-fixture-exact-output', ok: false }),
    ])
  })
  test('direct input is unchanged and the registered validator return value is the exact-output candidate', async () => {
    const direct = directGuide()
    let seen = ''
    const checks = await validateProgramFixture({
      guide: direct,
      implementation,
      validateOutputJson: (raw) => {
        seen = raw
        return '{"summary":"transformed"}'
      },
      fixtures: {
        async run({ inputJson }) {
          expect(JSON.parse(inputJson)).toEqual(JSON.parse(direct.input.exampleJson))
          return { kind: 'completed', rawStdout: ' \n not-json-yet \n ' }
        },
      },
    })
    expect(seen).toBe('not-json-yet')
    expect(checks[0]?.ok).toBe(true)
  })
  test('direct output still requires a registered validator', async () => {
    const checks = await validateProgramFixture({
      guide: directGuide(),
      implementation,
      fixtures: {
        async run() {
          return { kind: 'completed', rawStdout: '{"summary":"valid shape"}' }
        },
      },
    })
    expect(checks).toEqual([
      {
        code: 'program-fixture-exact-output',
        ok: false,
        detail: 'direct JSON output contract has no registered validator',
      },
    ])
  })
  test('mechanism failures retain their checks and do not invoke output validation', async () => {
    const checks = [
      { code: 'program-fixture-execution', ok: false, detail: 'script-timeout: last stderr' },
    ]
    const actual = await validateProgramFixture({
      guide: directGuide(),
      implementation,
      validateOutputJson: () => {
        throw Error('must not validate a failed process')
      },
      fixtures: {
        async run() {
          return { kind: 'failed', checks }
        },
      },
    })
    expect(actual).toBe(checks)
  })
  test('artifact-path output preserves the existing single-line rule', async () => {
    for (const [raw, ok] of [
      [' /tmp/result.md\n', true],
      ['one\ntwo', false],
    ] as const) {
      const checks = await validateProgramFixture({
        guide: { ...guide, outputMode: 'artifact-path' },
        implementation,
        fixtures: {
          async run() {
            return { kind: 'completed', rawStdout: raw }
          },
        },
      })
      expect(checks[0]?.ok).toBe(ok)
    }
  })
})

async function fixture(
  source: string,
  parameters: Record<string, string | number | boolean> | null = null,
) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc361-fixture-'))
  roots.push(appHome)
  const artifact = await createProgramArtifactStore(appHome).put({
    runtimeKind: 'node',
    source,
    parameterValues: parameters,
  })
  return {
    appHome,
    implementation: { ...implementation, ...artifact },
    runner: createExecutionContractProgramFixtureAdapter({
      appHome,
      scriptInterpreterOverrides: { node: process.execPath },
    }),
  }
}

describe('RFC-361 Task-owned real program fixture', () => {
  test('forwards exact input and parameters, returns stdout, and removes the temporary workspace', async () => {
    const f = await fixture(
      `process.stdout.write(JSON.stringify({cwd:process.cwd(),input:process.env.AW_PORT_CONTRACT_INPUT,parameters:process.env.DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON}))`,
      { mode: 'strict', retries: 0, enabled: false },
    )
    const result = await f.runner.run({
      implementation: f.implementation,
      inputJson: '{"value":0}',
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw Error('expected process output')
    const output = JSON.parse(result.rawStdout)
    expect(output.input).toBe('{"value":0}')
    expect(JSON.parse(output.parameters)).toEqual({ mode: 'strict', retries: 0, enabled: false })
    expect(existsSync(output.cwd)).toBe(false)
    expect(existsSync(dirname(output.cwd))).toBe(false)
  })
  test('preserves artifact, digest and parameter failures without starting the process', async () => {
    const f = await fixture('throw new Error("must not start")')
    const cases: Array<[Partial<typeof f.implementation>, string]> = [
      [{ executableArtifactRef: '../missing.js' }, 'program-artifact-contained'],
      [{ executableArtifactRef: 'missing.js' }, 'program-artifact-readable'],
      [{ executableDigest: 'wrong' }, 'program-artifact-digest'],
      [{ parameterValuesRef: '../parameters.json' }, 'program-parameter-artifact-contained'],
      [{ parameterValuesRef: 'missing.json' }, 'program-parameter-artifact-readable'],
    ]
    for (const [patch, code] of cases)
      expect(
        await f.runner.run({ implementation: { ...f.implementation, ...patch }, inputJson: '{}' }),
      ).toMatchObject({ kind: 'failed', checks: [{ code, ok: false }] })
    writeFileSync(join(f.appHome, 'bad-parameters.json'), '[1]')
    expect(
      await f.runner.run({
        implementation: { ...f.implementation, parameterValuesRef: 'bad-parameters.json' },
        inputJson: '{}',
      }),
    ).toMatchObject({
      kind: 'failed',
      checks: [{ code: 'program-parameter-artifact-readable', ok: false }],
    })
  })
  test('reports a missing interpreter through the original check', async () => {
    const f = await fixture('process.stdout.write("unused")')
    const runner = createExecutionContractProgramFixtureAdapter({
      appHome: f.appHome,
      scriptInterpreterOverrides: { node: join(f.appHome, 'missing-interpreter') },
    })
    expect(await runner.run({ implementation: f.implementation, inputJson: '{}' })).toEqual({
      kind: 'failed',
      checks: [{ code: 'program-interpreter-available', ok: false, detail: 'node' }],
    })
  })
  test('nonzero exit retains the last 1000 stderr characters and cleans the workspace', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'rfc361-marker-')), 'cwd')
    roots.push(dirname(marker))
    const f = await fixture(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.cwd());process.stderr.write('x'.repeat(1300));process.exit(3)`,
    )
    const result = await f.runner.run({ implementation: f.implementation, inputJson: '{}' })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw Error('expected failure')
    expect(result.checks[0]?.code).toBe('program-fixture-execution')
    expect(result.checks[0]?.detail.endsWith('x'.repeat(1000))).toBe(true)
    expect(existsSync(dirname(readFileSync(marker, 'utf8')))).toBe(false)
  })
  test('the fixed 30-second timeout returns the original check and cleans the workspace', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'rfc361-timeout-')), 'cwd')
    roots.push(dirname(marker))
    const f = await fixture(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.cwd());setInterval(()=>{},1000)`,
    )
    const result = await f.runner.run({ implementation: f.implementation, inputJson: '{}' })
    expect(result).toMatchObject({
      kind: 'failed',
      checks: [
        {
          code: 'program-fixture-execution',
          ok: false,
          detail: expect.stringContaining('script-timeout:'),
        },
      ],
    })
    expect(existsSync(dirname(readFileSync(marker, 'utf8')))).toBe(false)
  }, 60_000)
})

// This inventory is intentionally exact. Neither EC nor its composition can rebuild providers.
test('RFC-361 EC has required providers, no resource table/process adapter, and no reverse value edge', () => {
  const root = resolve(import.meta.dir, '../src/modules')
  expect(existsSync(join(root, 'execution-contract/infrastructure/taskExecutionAdapter.ts'))).toBe(
    false,
  )
  const composition = readFileSync(join(root, 'execution-contract/composition.ts'), 'utf8')
  for (const forbidden of [
    'DbClient',
    'appHome',
    'createExecutionContractResourceAdapter',
    'createExecutionContractProgramFixtureAdapter',
    '??',
  ])
    expect(composition).not.toContain(forbidden)
  const contract = readFileSync(
    join(root, 'execution-contract/composition/required-ports.ts'),
    'utf8',
  )
  expect(contract).toContain('run(input: ExecutionContractFixtureRequest)')
  const task = readFileSync(
    join(root, 'task-execution/infrastructure/adapters/executionContractFixtureAdapter.ts'),
    'utf8',
  )
  for (const forbidden of [
    'validateOutputJson',
    'validateExactContractOutput',
    'guide',
    'databaseSessionFor',
    '@/modules/execution-contract',
  ])
    expect(task).not.toContain(forbidden)
})
