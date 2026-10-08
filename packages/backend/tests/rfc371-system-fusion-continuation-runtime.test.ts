// Real fusion 01M4CKMGXPZXMARDQH49387ZQ2 resumed eight times on the boot runtime,
// although the live default still selected the explicitly marked validation runtime.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { resolveTaskStartLaunchConfiguration } from '@/modules/task-execution/application/launchConfiguration'
import type { TaskLaunchConfigurationSnapshot } from '@/modules/task-execution/application/ports/taskLaunchConfiguration'
import ts from 'typescript'
import { inverseTaskLaunchRootStatements } from './helpers/taskLaunchRootStatementInverse'

test('the local continuation retains its original live reader and current zero-valued policy', async () => {
  let current: TaskLaunchConfigurationSnapshot = {
    ...DEFAULT_CONFIG,
    defaultRuntime: 'boot-runtime',
    commitPushRuntime: 'boot-commit-runtime',
    defaultNodeRetries: 5,
    sessionRestartBudget: 2,
  }
  let reads = 0
  const queries = {
    read() {
      expect(this).toBe(queries)
      reads++
      return current
    },
  }
  const selected = composeTaskLaunchConfiguration({ kind: 'local-sync', queries })
  expect(reads).toBe(0)
  expect(selected.selectedQueries).toBeUndefined()
  expect(selected.continuationQueries).toBe(queries)
  expect(selected.initialRuntime().defaultRuntime).toBe('boot-runtime')
  current = {
    ...DEFAULT_CONFIG,
    defaultRuntime: 'validation-runtime',
    commitPushRuntime: 'validation-commit-runtime',
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
  }
  const actual = await resolveTaskStartLaunchConfiguration(selected.continuationQueries)
  expect(actual).toMatchObject({
    defaultRuntime: 'validation-runtime',
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
  })
  expect(actual.commitPush?.runtime).toBe('validation-commit-runtime')
  // The validated reader restores required defaults when optional overrides are
  // removed; neither the boot values nor the previous zero budgets may stick.
  current = { ...DEFAULT_CONFIG }
  const cleared = await resolveTaskStartLaunchConfiguration(selected.continuationQueries)
  expect(cleared.defaultRuntime).toBeUndefined()
  expect(cleared.commitPush?.runtime).toBeUndefined()
  expect(cleared.defaultNodeRetries).toBe(DEFAULT_CONFIG.defaultNodeRetries)
  expect(cleared.sessionRestartBudget).toBe(DEFAULT_CONFIG.sessionRestartBudget)
})

test('the async selected continuation awaits the same reader and original receiver', async () => {
  let current = 'before'
  const queries = {
    async read(): Promise<TaskLaunchConfigurationSnapshot> {
      expect(this).toBe(queries)
      await Promise.resolve()
      return { ...DEFAULT_CONFIG, defaultRuntime: current }
    },
  }
  const selected = composeTaskLaunchConfiguration({ kind: 'selected', queries })
  expect(selected.continuationQueries).toBe(queries)
  expect(selected.selectedQueries).toBe(queries)
  current = 'after'
  expect(
    (await resolveTaskStartLaunchConfiguration(selected.continuationQueries)).defaultRuntime,
  ).toBe('after')
})

test('the actual continuously running local gate worker receives the original live reader', () => {
  const source = readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8')
  const start = source.indexOf('  const gateContinuationDeps = {')
  const end = source.indexOf('  const humanGateContinuationRecovery', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const originalBinding = source.slice(start, end)
  expect(originalBinding).toContain(
    'launchConfiguration: taskLaunchConfiguration.continuationQueries',
  )
  expect(originalBinding).not.toContain(
    'launchConfiguration: taskLaunchConfiguration.selectedQueries',
  )
  expect(source).toContain('drive: composeHumanGateContinuationDriver(gateContinuationDeps)')
})

function actualContinuationRoot(text?: string) {
  const path = resolve(import.meta.dir, '../src/cli/start.ts')
  return ts.createSourceFile(path, text ?? readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

test('the complete Task root oracle accepts only the reviewed live continuation reader', () => {
  const actual = actualContinuationRoot()
  const restored = inverseTaskLaunchRootStatements(actual, 'composeSqliteProviderSession')
  expect(restored.fileName).toBe(actual.fileName)
  expect(restored.text).toContain('const gateContinuationDeps')
  expect(restored.text).not.toContain(
    'launchConfiguration: taskLaunchConfiguration.continuationQueries',
  )
})

test('the reviewed continuation inverse does not permit a different reader', () => {
  const actual = actualContinuationRoot()
  const changed = actualContinuationRoot(
    actual.text.replace(
      'launchConfiguration: taskLaunchConfiguration.continuationQueries',
      'launchConfiguration: taskLaunchConfiguration.selectedQueries',
    ),
  )
  expect(() => inverseTaskLaunchRootStatements(changed, 'composeSqliteProviderSession')).toThrow(
    'task-launch inverse unreviewed statement: gateContinuationDeps',
  )
})

test('the continuation inverse retains every unrelated property for the original hash check', () => {
  const actual = actualContinuationRoot()
  const changed = actualContinuationRoot(
    actual.text.replace(
      'launchConfiguration: taskLaunchConfiguration.continuationQueries,',
      'launchConfiguration: taskLaunchConfiguration.continuationQueries, unreviewed: true,',
    ),
  )
  expect(() => inverseTaskLaunchRootStatements(changed, 'composeSqliteProviderSession')).toThrow(
    'task-launch inverse unreviewed statement: gateContinuationDeps',
  )
})
