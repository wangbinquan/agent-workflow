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
    ['bootstrap/daemonModules/adapters.ts', 1],
    ['bootstrap/daemonModules/taskExecution.ts', 1],
  ] as const) {
    const source = read(path)
    expect(source).toContain("from '@/services/daemonGeneration'")
    expect(executionGenerationViolations(source, sites)).toEqual([])
  }
  const adapters = compact(read('bootstrap/daemonModules/adapters.ts'))
  expect(adapters).not.toContain('generationId')
  expect(adapters).toContain(
    "sqlite:({db})=>({provider:'sqlite',execution:()=>composeProcessTaskExecutionBinding(db)",
  )
  expect(adapters).toContain(
    "postgresql:({runtime})=>({provider:'postgresql',execution:(persistence)=>composeSessionTaskExecutionBinding(",
  )
  const bundle = read('bootstrap/daemonModules/taskExecution.ts')
  expect(bundle).not.toContain('input.adapters.daemonGeneration')
  expect(bundle).not.toContain('readonly daemonGeneration:')
  const recovery = bootImplementation(
    read('bootstrap/daemonApplication.ts'),
    'task-execution-recovery',
  )
  expect(compact(recovery)).toContain(
    'createDaemonRecoveryAuthorityProof(awaitreadDaemonStartupRecoveryAuthority(requireStartupLease(input.daemonStartupLease),adapter.recoveryProofGeneration(input.provider),),)',
  )
  expect(recovery).not.toContain('createDaemonLockProof')
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
  expect(read('bootstrap/daemonSessionAdapters.ts')).toContain(
    'recoveryProofGeneration: () => DAEMON_GENERATION',
  )
  expect(read('modules/task-execution/composition/taskExecutionBinding.ts')).toContain(
    'const module = createProviderTaskExecutionModule(input)',
  )
  expect(read('bootstrap/daemonModules/adapters.ts')).toContain(
    'daemonGeneration: DAEMON_GENERATION',
  )
  // The selected startup lease contract is deliberately outside the standalone proof change.
  expect(read('bootstrap/daemonSessionAdapters.ts')).toContain(
    'recoveryProofGeneration: (provider) => provider.runtime.generationId',
  )
  expect(read('modules/task-execution/composition/crewstationExecution.ts')).toContain(
    'daemonGeneration: lease.instanceId',
  )
})

test('database write fencing continues to use the database generation', () => {
  const source = read('platform/persistence/postgresqlDatabaseClient.ts')
  expect(source.match(/\[runtime\.generationId\]/g)).toHaveLength(3)
  expect(source).toContain('fencedInsert(table, value, runtime.generationId)')
  expect(source).toContain('generation_id = ${generationId}')
  expect(source).toContain('unfenced.execute(query)')
  expect(source).toContain('affectedRows(result) !== 1')
  expect(source).toContain('$generationId: runtime.generationId')
  expect(source).not.toContain('DAEMON_GENERATION')
})
