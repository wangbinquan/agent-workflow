// Real fusion 01M4CKMGXPZXMARDQH49387ZQ2 resumed eight times on the boot runtime,
// although the live default still selected the explicitly marked validation runtime.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { resolveTaskStartLaunchConfiguration } from '@/modules/task-execution/application/launchConfiguration'
import type { TaskLaunchConfigurationSnapshot } from '@/modules/task-execution/application/ports/taskLaunchConfiguration'

test('the local continuation retains its original live reader and current zero-valued policy', async () => {
  let current: TaskLaunchConfigurationSnapshot = {
    defaultRuntime: 'boot-runtime',
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
    defaultRuntime: 'validation-runtime',
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
  }
  const actual = await resolveTaskStartLaunchConfiguration(selected.continuationQueries)
  expect(actual).toMatchObject({
    defaultRuntime: 'validation-runtime',
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
  })
  // Removing a policy must clear the boot value rather than reintroducing it.
  current = {}
  const cleared = await resolveTaskStartLaunchConfiguration(selected.continuationQueries)
  expect(cleared.defaultRuntime).toBeUndefined()
  expect(cleared.defaultNodeRetries).toBeUndefined()
  expect(cleared.sessionRestartBudget).toBeUndefined()
})

test('the async selected continuation awaits the same reader and original receiver', async () => {
  let current = 'before'
  const queries = {
    async read(): Promise<TaskLaunchConfigurationSnapshot> {
      expect(this).toBe(queries)
      await Promise.resolve()
      return { defaultRuntime: current }
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
