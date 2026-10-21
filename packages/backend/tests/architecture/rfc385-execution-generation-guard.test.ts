// RFC-385: lock process generations at the execution wiring sites while preserving database
// write generations and the selected/CrewStation startup authority. Former wiring must fail.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootImplementation } from '../helpers/daemonProgramSource'

const read = (path: string) => readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8')
const compact = (source: string) => source.replace(/\s/g, '')

function executionGenerationViolations(source: string, expectedSites: number): string[] {
  const values = [...source.matchAll(/\bdaemonGeneration\s*:\s*([^,\n}]+)/g)].map((match) =>
    match[1]!.trim(),
  )
  const violations = values.filter((value) => value !== 'DAEMON_GENERATION')
  if (values.length !== expectedSites)
    violations.push(`expected ${expectedSites} execution generation sites, got ${values.length}`)
  return violations
}

test('execution module, provider runtime, fusion, run configuration and standalone proof use the process generation', () => {
  for (const [path, sites] of [
    ['cli/daemonModules/adapters.ts', 2],
    ['cli/daemonModules/taskExecution.ts', 1],
    ['cli/postgresqlDaemonApplication.ts', 1],
  ] as const) {
    const source = read(path)
    expect(source).toContain("from '@/services/daemonGeneration'")
    expect(executionGenerationViolations(source, sites)).toEqual([])
  }
  const adapters = compact(read('cli/daemonModules/adapters.ts'))
  expect(adapters).not.toContain('generationId')
  expect(adapters).toContain("sqlite:({db})=>({provider:'sqlite',compose(input)")
  expect(adapters).toContain("postgresql:({db,runtime})=>({provider:'postgresql',compose(input)")
  const bundle = read('cli/daemonModules/taskExecution.ts')
  expect(bundle).not.toContain('input.adapters.daemonGeneration')
  expect(bundle).not.toContain('readonly daemonGeneration:')
  const recovery = bootImplementation(
    read('cli/postgresqlDaemonApplication.ts'),
    'task-execution-recovery',
  )
  expect(compact(recovery)).toContain(
    'createDaemonLockProof({lockPath:input.lockPath,lockPid:process.pid,daemonGeneration:DAEMON_GENERATION,})',
  )
})

test('negative fixtures reject the former database/adapter wiring and missing sites', () => {
  expect(
    executionGenerationViolations('const owner = { daemonGeneration: runtime.generationId };', 1),
  ).toEqual(['runtime.generationId'])
  expect(
    executionGenerationViolations(
      'const proof = { daemonGeneration: input.provider.runtime.generationId };',
      1,
    ),
  ).toEqual(['input.provider.runtime.generationId'])
  expect(
    executionGenerationViolations(
      'const run = { daemonGeneration: input.adapters.daemonGeneration };',
      1,
    ),
  ).toEqual(['input.adapters.daemonGeneration'])
  expect(executionGenerationViolations('const missing = {};', 1)).toEqual([
    'expected 1 execution generation sites, got 0',
  ])
  expect(
    executionGenerationViolations('const owner = { daemonGeneration: DAEMON_GENERATION };', 1),
  ).toEqual([])
})

test('SQLite, child runtime inheritance and CrewStation keep their existing generation sources', () => {
  expect(read('modules/task-execution/composition.ts')).toContain(
    'new TaskExecutionModule(DAEMON_GENERATION)',
  )
  expect(read('cli/start.ts')).toContain(
    'readDaemonStartupRecoveryAuthority(lock, DAEMON_GENERATION)',
  )
  expect(read('modules/task-execution/composition/providerRuntime.ts')).toContain(
    'daemonGeneration: dependencies.runtime.daemonGeneration',
  )
  // The selected startup lease contract is deliberately outside the standalone proof change.
  expect(compact(read('cli/postgresqlDaemonApplication.ts'))).toContain(
    'readDaemonStartupRecoveryAuthority(input.daemonStartupLease,input.provider.runtime.generationId,)',
  )
  expect(read('modules/task-execution/composition/crewstationExecution.ts')).toContain(
    'daemonGeneration: lease.instanceId',
  )
})

test('database write fencing continues to use the database generation', () => {
  const source = read('platform/persistence/postgresqlDatabaseClient.ts')
  expect(source.match(/\[runtime\.generationId\]/g)).toHaveLength(2)
  expect(source).toContain('client.unsafe(folded, [...parameters, runtime.generationId])')
  expect(source).toContain("if (property === '$generationId') return input.runtime.generationId")
  expect(source).not.toContain('DAEMON_GENERATION')
})
