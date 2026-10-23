// RFC-370: selected settings must be awaited at mint/commit time; frozen run
// facts remain independent of later setting edits. Both providers use the
// real node runtime persistence, without starting a runtime or local service.
import { deriveNodeRunRole } from '@/modules/task-execution/public/types'
import { taskFixture, workflowFixture, readNodeRunFixtures } from './helpers/model'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import type { TaskOperationConfigurationQueries } from '@/modules/task-execution/public/queries'
import { mintNodeRun, resolveFrozenRuntimeWith } from '@/services/nodeRunMint'
import { freezeBinaryConfig } from '@/services/execution/runtimeConfigFreeze'
import { readCommitExcludePatterns, pickInheritableRunConfig } from '@/services/scheduler'
import { describeEachProvider } from './helpers/eachProvider'
import { composeNodeRunRuntimePersistence } from './helpers/nodeRunRuntime'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

function absentConfig() {
  const root = mkdtempSync(join(tmpdir(), 'aw-operation-config-'))
  directories.push(root)
  return join(root, 'absent-home', 'config.json')
}

describeEachProvider('RFC-370 Task operation configuration', (harness) => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol} waits for selected settings, freezes their binary and retains it after settings change`, async () => {
      const configPath = absentConfig(),
        entered = barrier(),
        release = barrier()
      await workflowFixture(harness.db, { id: 'wf', name: 'config', definition: '{}' })
      await taskFixture(harness.db, {
        id: 'task',
        name: 'config',
        workflowId: 'wf',
        workflowSnapshot: '{}',
        repoPath: '/tmp/r',
        worktreePath: '/tmp/w',
        baseBranch: 'main',
        branch: 'b',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
        schemaVersion: 1,
        executionLineageId: 'task',
        lineageSlotPathJson: JSON.stringify([
          { stableNodeKey: 'task-root', frozenOccurrenceKey: 'task', workflowRevision: null },
        ]),
      })
      const first = await mintNodeRun(harness.db, {
        ...deriveNodeRunRole({ nodeId: 'first', rerunCause: 'initial' }),
        taskId: 'task',
        nodeId: 'first',
        status: 'pending',
        cause: 'initial',
      })
      const persistence = composeNodeRunRuntimePersistence(harness.db)
      let binary = '/selected/first',
        reads = 0,
        settled = false
      const configuration: TaskOperationConfigurationQueries = {
        async readBinaryPaths() {
          reads++
          if (reads === 1) {
            entered.release()
            await release.pending
          }
          return { opencodePath: binary, claudeCodePath: binary }
        },
        readCommitExcludePatterns: () => [],
      }
      const inherited = {
        protocol,
        binary: null,
        params: {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        },
        configDir: DEFAULT_CONFIG_DIR_PROFILE[protocol],
      }
      const pending = freezeBinaryConfig(configPath, configuration)
        .then((settings) =>
          resolveFrozenRuntimeWith(persistence, first, null, null, inherited, settings),
        )
        .then((snapshot) => {
          settled = true
          return snapshot
        })
      try {
        await Promise.race([
          entered.pending,
          pending.then(() => {
            throw new Error('selected settings not reached')
          }),
        ])
        expect(settled).toBe(false)
        expect(await persistence.load(first)).toMatchObject({ runtime: null, runtimeBinary: null })
        release.release()
        expect(await pending).toMatchObject({ protocol, binary: '/selected/first' })
        expect(await persistence.load(first)).toMatchObject({
          runtime: protocol,
          runtimeBinary: '/selected/first',
        })
        binary = '/selected/second'
        const current = await freezeBinaryConfig(configPath, configuration)
        expect(
          await resolveFrozenRuntimeWith(persistence, first, null, null, undefined, current),
        ).toMatchObject({ protocol, binary: '/selected/first' })
        const second = await mintNodeRun(harness.db, {
          ...deriveNodeRunRole({ nodeId: 'second', rerunCause: 'initial' }),
          taskId: 'task',
          nodeId: 'second',
          status: 'pending',
          cause: 'initial',
        })
        expect(
          await resolveFrozenRuntimeWith(persistence, second, null, null, inherited, current),
        ).toMatchObject({ protocol, binary: '/selected/second' })
        expect(reads).toBe(2)
        expect((await readNodeRunFixtures(harness.db, { id: first }))[0]?.runtimeBinary).toBe(
          '/selected/first',
        )
        expect(existsSync(configPath)).toBe(false)
      } finally {
        release.release()
        await pending.catch(() => {})
      }
    })
  }
})

test('commit settings are awaited and copied per operation; selected failures use the original launch fallback without file reads', async () => {
  const configPath = absentConfig(),
    entered = barrier(),
    release = barrier()
  const patterns = ['first/**'],
    fallback = ['launch/**']
  let unavailable = false,
    settled = false
  const configuration: TaskOperationConfigurationQueries = {
    async readBinaryPaths() {
      throw new Error('selected configuration offline')
    },
    async readCommitExcludePatterns() {
      if (unavailable) throw new Error('selected configuration offline')
      entered.release()
      await release.pending
      return patterns
    },
  }
  const opts = {
    taskId: 'task',
    appHome: '/unused',
    configPath,
    operationConfiguration: configuration,
    commitPushExcludePatterns: fallback,
  }
  const pending = readCommitExcludePatterns(opts).then((value) => {
    settled = true
    return value
  })
  try {
    await Promise.race([
      entered.pending,
      pending.then(() => {
        throw new Error('selected commit settings not reached')
      }),
    ])
    expect(settled).toBe(false)
    release.release()
    const first = await pending
    patterns[0] = 'second/**'
    expect(first).toEqual(['first/**'])
    expect(await readCommitExcludePatterns(opts)).toEqual(['second/**'])
    unavailable = true
    const projectedFallback = await readCommitExcludePatterns(opts)
    fallback[0] = 'later/**'
    expect(projectedFallback).toEqual(['launch/**'])
    expect(await freezeBinaryConfig(configPath, configuration)).toBeUndefined()
    expect(existsSync(configPath)).toBe(false)
    expect(pickInheritableRunConfig(opts)).not.toHaveProperty('operationConfiguration')
  } finally {
    release.release()
    await pending.catch(() => {})
  }
})

test('absent standalone paths retain no-query and launch fallback behavior', async () => {
  expect(await freezeBinaryConfig(undefined)).toBeUndefined()
  expect(await freezeBinaryConfig('')).toBeUndefined()
  expect(
    await readCommitExcludePatterns({
      taskId: 'task',
      appHome: '/unused',
      commitPushExcludePatterns: ['launch/**'],
    }),
  ).toEqual(['launch/**'])
})
