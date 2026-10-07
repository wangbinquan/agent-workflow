// RFC-370 H1/A-T7: real caller closure keeps local sync semantics and carries the
// selected async source through short-lived drive, preparation and continuation.
import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { resolveTaskStartLaunchConfiguration } from '@/modules/task-execution/application/launchConfiguration'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import {
  createTaskDriveCoordinator,
  composeWorkgroupTaskRoomContinuationDriver,
  startTask,
  type StartTaskDeps,
} from '@/services/task'
import { tasks, workflows, taskExecutionIntents } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { submitTaskContinuation } from '@/modules/task-execution/application/submitTaskContinuation'
import { awaitTaskDriverIdle } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import type { TaskDriveRequest } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { DefaultTaskDriveCoordinatorOptions } from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskLaunchConfigurationQueries } from '@/modules/task-execution/public/queries'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import { repositoryPreparationFactsJson } from '@/modules/source-control/domain/repositoryPreparationFacts'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/application/ports/repositoryPreparationEffects'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home() {
  const value = mkdtempSync(join(tmpdir(), 'aw-launch-closure-'))
  homes.push(value)
  return value
}
function runtimeOf(coordinator: unknown) {
  return (coordinator as { options: DefaultTaskDriveCoordinatorOptions }).options.runtime
}

test('selection does no read; local startup stays sync and selected start preserves receiver and four independent reads', async () => {
  let calls = 0
  const source = {
    read() {
      expect(this).toBe(source)
      calls++
      return {
        ...DEFAULT_CONFIG,
        defaultRuntime: 'local',
        subagentLiveCapture: { pollMs: 42, consecutiveFailureLimit: 2 },
      }
    },
  }
  const local = composeTaskLaunchConfiguration({ kind: 'local-sync', queries: source })
  expect(calls).toBe(0)
  expect(local.start()).not.toBeInstanceOf(Promise)
  expect(calls).toBe(4)
  expect(local.selectedQueries).toBeUndefined()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const selected = {
    async read() {
      expect(this).toBe(selected)
      const index = calls++ - 4
      if (index === 1) {
        entered.resolve()
        await gate.promise
      }
      return {
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 100 + index, consecutiveFailureLimit: 3 },
        commitPushRuntime: `commit-${index}`,
        defaultRuntime: `runtime-${index}`,
        defaultNodeRetries: 0,
        sessionRestartBudget: 0,
        gitBaselineSyncWindowMs: 0,
        maxActiveChildTasks: 20 + index,
        maxInvocationDepth: 30 + index,
      }
    },
  }
  const binding = composeTaskLaunchConfiguration({ kind: 'selected', queries: selected })
  expect(binding.initialRuntime()).toEqual({})
  expect(binding.initialStart()).toEqual({})
  expect(calls).toBe(4)
  let settled = false
  const pending = Promise.resolve(binding.start()).then((value) => {
    settled = true
    return value
  })
  try {
    await entered.promise
    expect(settled).toBe(false)
    gate.resolve()
    const value = await pending
    expect(calls).toBe(8)
    expect(value.subagentLiveCapture?.pollMs).toBe(100)
    expect(value.commitPush?.runtime).toBe('commit-1')
    expect(value.defaultRuntime).toBe('runtime-2')
    expect(value.defaultNodeRetries).toBe(0)
    expect(value.sessionRestartBudget).toBe(0)
    expect(value.gitBaselineSyncWindowMs).toBe(0)
    expect(value.maxActiveChildTasks).toBe(23)
    expect(value.maxInvocationDepth).toBe(33)
  } finally {
    gate.resolve()
    await pending
  }
})

for (const failureIndex of [0, 1, 2, 3]) {
  test(`start policy keeps independent fallback ${failureIndex} and clears stale selected fields`, async () => {
    let calls = 0
    const query = {
      async read() {
        const index = calls++
        if (index === failureIndex) throw new Error('selected read failed')
        return {
          ...DEFAULT_CONFIG,
          subagentLiveCapture: { pollMs: 300, consecutiveFailureLimit: 4 },
          commitPushRuntime: 'commit',
          defaultRuntime: 'selected',
          defaultNodeRetries: 0,
          maxActiveChildTasks: 8,
          gitBaselineSyncWindowMs: 0,
        }
      },
    }
    const value = await resolveTaskStartLaunchConfiguration(query)
    expect(calls).toBe(4)
    expect(value.subagentLiveCapture).toEqual(
      failureIndex === 0 ? undefined : { pollMs: 300, consecutiveFailureLimit: 4 },
    )
    expect(value.commitPush?.runtime).toBe(failureIndex === 1 ? undefined : 'commit')
    expect(value.defaultRuntime).toBe(failureIndex === 2 ? undefined : 'selected')
    expect(value.maxActiveChildTasks).toBe(failureIndex === 3 ? undefined : 8)
    const mixed = { defaultRuntime: 'stale', cloneTimeoutMs: 999, ...value }
    expect(mixed.defaultRuntime).toBe(value.defaultRuntime)
    expect(mixed.cloneTimeoutMs).toBe(value.cloneTimeoutMs)
  })
}

test('default file binding exposes the same sync source; explicit overrides and selected persistence never acquire it', async () => {
  const path = join(home(), 'config.json')
  writeFileSync(path, JSON.stringify({ defaultRuntime: 'local' }))
  const local = composeApplicationConfigurationBinding({ kind: 'file', configPath: path })
  expect(local.synchronousQueries?.read().defaultRuntime).toBe('local')
  const other = {
    read() {
      expect(this).toBe(other)
      return { ...DEFAULT_CONFIG, defaultRuntime: 'explicit' }
    },
  }
  const override = composeApplicationConfigurationBinding({
    kind: 'file',
    configPath: path,
    queries: other,
  })
  expect(override.synchronousQueries).toBeUndefined()
  expect((await override.queries.read()).defaultRuntime).toBe('explicit')
  const persistence = {
    load: async () => ({ ...DEFAULT_CONFIG }),
    previewPatch: async () => ({ ...DEFAULT_CONFIG }),
    applyPatch: async () => ({ ...DEFAULT_CONFIG }),
  }
  const selected = composeApplicationConfigurationBinding({
    kind: 'selected',
    persistence,
    notificationKey: 'selected:configuration',
  })
  expect(selected.synchronousQueries).toBeUndefined()
  expect(() =>
    composeTaskLaunchConfiguration({
      kind: 'selected',
      queries: {} as TaskLaunchConfigurationQueries,
    }),
  ).toThrow('task-launch-configuration-incomplete')
})

describeEachProvider('RFC-370 selected task caller and repository budget closure', (harness) => {
  test('a transferred workspace remains owned while configuration waits and a later launch error waits for cleanup ACK', async () => {
    const appHome = home(),
      worktreePath = join(appHome, 'transferred-workspace'),
      configPath = join(appHome, 'absent-transferred.json')
    mkdirSync(worktreePath)
    writeFileSync(join(worktreePath, 'owned.txt'), 'transferred launch material')
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      cleanupEntered = Promise.withResolvers<void>(),
      cleanupRelease = Promise.withResolvers<void>()
    let reads = 0,
      drives = 0,
      settled = false
    const query: TaskLaunchConfigurationQueries = {
      async read() {
        expect(this).toBe(query)
        if (reads++ === 0) {
          entered.resolve()
          await release.promise
        }
        return { ...DEFAULT_CONFIG, defaultNodeRetries: 0 }
      },
    }
    const pending = startTask(
      { workflowId: `missing-${ulid()}`, name: 'transferred configuration wait' },
      {
        db: harness.db,
        appHome,
        configPath,
        gitCommitIdentity: null,
        launchProvenance: { kind: 'direct-multipart', initiator: 'manual' },
        launchConfiguration: query,
        schedulerDriver: {
          async drive() {
            drives++
          },
        },
        preCreatedWorktree: {
          taskId: ulid(),
          worktreePath,
          branch: 'transferred',
          baseCommit: 'transferred-base',
          cleanup: { kind: 'owned-root', path: worktreePath },
        },
        async workspaceCleanupHook(event) {
          expect(event.stage).toBe('owned-root-remove')
          expect(event.path).toBe(worktreePath)
          cleanupEntered.resolve()
          await cleanupRelease.promise
        },
      },
    )
      .then(
        () => {
          throw new Error('missing workflow unexpectedly launched')
        },
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('launch missed configuration ACK')
        }),
      ])
      expect(settled).toBe(false)
      expect(existsSync(worktreePath)).toBe(true)
      expect(drives).toBe(0)
      expect(await harness.db.select().from(tasks)).toEqual([])
      release.resolve()
      await Promise.race([
        cleanupEntered.promise,
        pending.then(() => {
          throw new Error('launch missed cleanup ACK')
        }),
      ])
      expect(reads).toBe(4)
      expect(settled).toBe(false)
      expect(existsSync(worktreePath)).toBe(true)
      cleanupRelease.resolve()
      expect(await pending).toMatchObject({ code: 'workflow-not-found' })
      expect(existsSync(worktreePath)).toBe(false)
      expect(existsSync(configPath)).toBe(false)
      expect(drives).toBe(0)
      expect(await harness.db.select().from(tasks)).toEqual([])
    } finally {
      release.resolve()
      cleanupRelease.resolve()
      await pending
    }
  })

  test('a short-lived coordinator consumes the query from deps, refreshes it, and preserves explicit command priority', async () => {
    const path = join(home(), 'absent.json')
    let current: Config = { ...structuredClone(DEFAULT_CONFIG), defaultRuntime: 'before' }
    let reads = 0,
      localReads = 0
    const query: TaskLaunchConfigurationQueries = {
      async read() {
        expect(this).toBe(query)
        reads++
        return current
      },
    }
    const deps: Pick<StartTaskDeps, 'launchConfiguration' | 'launchConfigurationOverrides'> = {
      launchConfiguration: query,
      launchConfigurationOverrides: { defaultNodeRetries: 0 },
    }
    const coordinator = createTaskDriveCoordinator({
      deps: { db: harness.db, schedulerDriver: { async drive() {} }, configPath: path, ...deps },
      appHome: home(),
      refreshLaunchConfig: () => {
        localReads++
        throw new Error('legacy reader used')
      },
      engineFailureMessage: 'unexpected drive failure',
      failureReporter: { report() {} },
    })
    expect(reads).toBe(0)
    expect((await runtimeOf(coordinator)).runtime.defaultRuntime).toBe('before')
    current = { ...current, defaultRuntime: 'after', defaultNodeRetries: 4 }
    const fresh = await runtimeOf(coordinator)
    expect(fresh.runtime.defaultRuntime).toBe('after')
    expect(fresh.runtime.defaultNodeRetries).toBe(0)
    expect(reads).toBe(8)
    expect(localReads).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  test('repository effect waits for live budget before actual factory, keeps receiver, and observes the next budget', async () => {
    const journal = createRepositoryPreparationJournal(harness.db)
    const factsJson = repositoryPreparationFactsJson({
      version: 1,
      kind: 'repository',
      repositories: [],
      groups: [],
      groupName: null,
      layout: { repos: [], nodes: [] },
    })
    const source = await journal.seal({
      id: `sc:source:v1:${ulid()}`,
      requestKey: ulid(),
      requestDigest: 'configuration-closure',
      kind: 'repository',
      factsJson,
      createdAt: 1,
    })
    const frozen = decodeRepositoryLaunchRef('preparation', `sc:preparation:v1:${ulid()}`)
    await journal.freeze({
      id: frozen,
      sourceRef: source.id,
      revision: `sha256:${sha256Hex(factsJson)}`,
      factsJson,
      createdAt: 1,
    })
    const operation = decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`)
    await journal.plan({ id: operation, snapshotRef: frozen, now: 1 })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let budget: number | undefined = 123
    const seen: Array<number | undefined> = []
    const query = {
      async read() {
        expect(this).toBe(query)
        entered.resolve()
        await release.promise
        return budget === undefined ? {} : { cloneTimeoutMs: budget }
      },
    }
    const factory: RepositoryPreparationEffectFactory = {
      create(input) {
        expect(this).toBe(factory)
        seen.push(input.cloneTimeoutMs)
        return {
          assertCurrent: input.assertCurrent,
          async resolveCommits() {
            throw new Error('unused')
          },
          async materialize() {
            throw new Error('unused')
          },
          async cleanup() {
            throw new Error('unused')
          },
        }
      },
    }
    const root = composeRepositoryPreparation({
      db: harness.db,
      appHome: home(),
      cloneTimeoutMs: 999,
      preparationConfiguration: query,
      preparationEffects: factory,
    })
    const request = {
      taskId: 'configuration-closure',
      operationRef: operation,
      gitCommitIdentity: null,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    }
    const before = await journal.operation(operation)
    const pending = root.effect(request)
    try {
      await entered.promise
      expect(seen).toEqual([])
      expect(await journal.operation(operation)).toEqual(before)
      release.resolve()
      await (await pending).close()
      expect(seen).toEqual([123])
      budget = 456
      await (await root.effect(request)).close()
      budget = undefined
      await (await root.effect(request)).close()
      expect(seen).toEqual([123, 456, undefined])
      expect(await journal.operation(operation)).toEqual(before)
    } finally {
      release.resolve()
      await pending
    }
  })

  test('workgroup continuation waits before wake and its actual short coordinator projects fresh settings without a second intent', async () => {
    const workflowId = ulid(),
      taskId = ulid(),
      intentId = ulid()
    const snapshot = JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] })
    await harness.db
      .insert(workflows)
      .values({ id: workflowId, name: 'continuation config', definition: snapshot })
    await harness.db.insert(tasks).values({
      id: taskId,
      name: 'continuation config',
      workflowId,
      workflowSnapshot: snapshot,
      rootTaskId: taskId,
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
      repoPath: 'selected-workspace',
      worktreePath: 'selected-workspace',
      branch: `agent-workflow/${taskId}`,
      baseBranch: 'main',
      status: 'pending',
      inputs: '{}',
      startedAt: 1,
    })
    const persistence = createTaskExecutionPersistence(harness.db)
    await submitTaskContinuation(persistence.intents, {
      taskId,
      intentId,
      kind: 'gate-continuation',
      source: 'internal',
      actorUserId: null,
      payload: {},
      now: Date.now(),
      advanceOperationGeneration: false,
    })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let reads = 0
    const query: TaskLaunchConfigurationQueries = {
      async read() {
        expect(this).toBe(query)
        const index = reads++
        if (index === 0) {
          entered.resolve()
          await release.promise
        }
        return {
          ...DEFAULT_CONFIG,
          defaultRuntime: `continued-${index}`,
          commitPushRuntime: `commit-${index}`,
          defaultNodeRetries: 0,
          maxActiveChildTasks: 40 + index,
          subagentLiveCapture: { pollMs: 100 + index, consecutiveFailureLimit: 4 },
        }
      },
    }
    const drives: TaskDriveRequest[] = []
    const file = join(home(), 'absent-continuation.json')
    const room = composeWorkgroupTaskRoomContinuationDriver({
      db: harness.db,
      configPath: file,
      taskRecoveryOperations: persistence.recoveryAdministration,
      workspacePresence: {
        async exists() {
          return true
        },
      },
      launchConfiguration: query,
      schedulerDriver: {
        async drive(request) {
          drives.push(request)
        },
      },
    })
    let settled = false
    const pending = room.driveAfterCommit({ taskId, intentId }).finally(() => {
      settled = true
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('continuation ended before selected configuration ACK')
        }),
      ])
      expect(settled).toBe(false)
      expect(drives).toEqual([])
      expect(
        (
          await harness.db
            .select()
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.id, intentId))
        )[0]?.state,
      ).toBe('pending')
      release.resolve()
      await pending
      await awaitTaskDriverIdle(taskId)
      expect(reads).toBe(8)
      expect(drives).toHaveLength(1)
      expect(drives[0]?.defaultRuntime).toBe('continued-5')
      expect(drives[0]?.commitPushRuntime).toBe('commit-4')
      expect(drives[0]?.maxActiveChildTasks).toBe(46)
      expect(drives[0]?.subagentLiveCapture).toEqual({ pollMs: 107, consecutiveFailureLimit: 4 })
      expect(drives[0]?.defaultNodeRetries).toBe(0)
      expect(
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, taskId)),
      ).toHaveLength(1)
      expect(existsSync(file)).toBe(false)
    } finally {
      release.resolve()
      await pending
      await awaitTaskDriverIdle(taskId)
    }
  }, 30_000)
})
