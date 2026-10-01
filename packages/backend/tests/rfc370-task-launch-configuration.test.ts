// RFC-370: async launch settings retain the three independent live-read and
// fallback boundaries. The coordinator must wait after attach and release its
// lifecycle if runtime resolution fails. Standalone sync entry points remain.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import type { TaskLaunchConfigurationQueries } from '@/modules/task-execution/public/queries'
import {
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskSubagentLiveCapture,
  resolveTaskUploadLimits,
} from '@/modules/task-execution/application/launchConfiguration'
import {
  DefaultTaskDriveCoordinator,
  type DefaultTaskDriveCoordinatorOptions,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createTaskExecutionContext } from '@/modules/task-execution/composition/sqliteTaskExecutionContext'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { resolveCommitPushConfig, resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { resolveSubagentLiveCapture, buildStartTaskDeps } from '@/services/startTaskDeps'
import { resolveUploadLimits } from '@/services/launchMultipart'
import { DEFAULT_UPLOAD_LIMITS } from '@/services/upload'
import { createTaskDriveCoordinator } from '@/services/task'
import { describeEachProvider } from './helpers/eachProvider'
import { createNoopSchedulerDriver } from './helpers/taskExecutionTestTopology'

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
function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), 'aw-launch-config-'))
  directories.push(home)
  return home
}
function currentConfiguration() {
  return {
    ...DEFAULT_CONFIG,
    commitPushModel: 'commit-model',
    commitPushRuntime: 'commit-runtime',
    commitPushMaxRepairRetries: 0,
    commitPushDiffMaxBytes: 12345,
    commitPushLang: 'zh-CN' as const,
    taskCommitExcludePatterns: ['generated/**'],
    defaultRuntime: 'runtime-live',
    maxConcurrentNodes: 7,
    maxConcurrentScriptNodes: 3,
    maxConcurrentCodeHostCalls: 2,
    codeHostRequestTimeoutMs: 777,
    codeHostResponseMaxBytes: 888,
    multiProcessSubprocessConcurrency: 5,
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
    defaultPerNodeTimeoutMs: 999,
    gitCloneTimeoutMs: 1111,
    gitBaselineSyncWindowMs: 0,
    mergeAgentRuntime: 'merge-runtime',
    mergeAgentModel: 'merge-model',
    maxActiveChildTasks: 8,
    maxInvocationDepth: 9,
    scriptInterpreters: {
      python: '/selected/python',
      bash: '/selected/bash',
      node: '/selected/node',
    },
    scriptDepsInstallTimeoutMs: 2222,
    subagentLiveCapture: { pollMs: 1234, consecutiveFailureLimit: 6 },
    uploadLimits: { perFile: 321, perRequest: 654, perCount: 3 },
  }
}

test('each live-read boundary is awaited, retains zero-valued policy, and matches sync projections', async () => {
  const entered = [barrier(), barrier(), barrier()],
    release = [barrier(), barrier(), barrier()]
  const snapshots = [
    currentConfiguration(),
    { ...currentConfiguration(), defaultRuntime: 'runtime-next' },
    { ...currentConfiguration(), maxActiveChildTasks: 19 },
  ]
  let reads = 0,
    settled = false
  const query: TaskLaunchConfigurationQueries = {
    async read() {
      const at = reads++
      const signal = entered[at],
        gate = release[at],
        snapshot = snapshots[at]
      if (signal === undefined || gate === undefined || snapshot === undefined)
        throw new Error('unexpected launch read')
      signal.release()
      await gate.pending
      return snapshot
    },
  }
  const pending = resolveTaskLaunchRuntimeConfiguration(query).then((value) => {
    settled = true
    return value
  })
  try {
    for (let at = 0; at < 3; at++) {
      await entered[at]!.pending
      expect(reads).toBe(at + 1)
      expect(settled).toBe(false)
      release[at]!.release()
    }
    const actual = await pending
    let syncAt = 0
    const expected = resolveTaskLaunchRuntimeFromReader(() => snapshots[syncAt++]!)
    expect(actual).toEqual(expected)
    expect(actual).toMatchObject({
      commitPush: { runtime: 'commit-runtime', lang: 'zh-CN', maxRepairRetries: 0 },
      defaultRuntime: 'runtime-next',
      defaultNodeRetries: 0,
      sessionRestartBudget: 0,
      gitBaselineSyncWindowMs: 0,
      maxActiveChildTasks: 19,
      maxInvocationDepth: 9,
      maxConcurrentCodeHostCalls: 2,
      codeHostRequestTimeoutMs: 777,
      codeHostResponseMaxBytes: 888,
      scriptInterpreters: snapshots[1]!.scriptInterpreters,
      scriptDepsInstallTimeoutMs: 2222,
    })
    expect(reads).toBe(3)
  } finally {
    for (const gate of release) gate.release()
    await pending.catch(() => {})
  }
})

test('one failed read leaves the other two original policy sections intact', async () => {
  for (let failedAt = 0; failedAt < 3; failedAt++) {
    let at = 0
    const resolved = await resolveTaskLaunchRuntimeConfiguration({
      async read() {
        if (at++ === failedAt) throw new Error('selected source offline')
        return currentConfiguration()
      },
    })
    expect(at).toBe(3)
    expect(resolved.commitPush).toEqual(
      failedAt === 0
        ? undefined
        : resolveTaskLaunchRuntimeFromReader(currentConfiguration).commitPush,
    )
    expect(resolved.defaultRuntime).toBe(failedAt === 1 ? undefined : 'runtime-live')
    expect(resolved.maxActiveChildTasks).toBe(failedAt === 2 ? undefined : 8)
  }
  const invalidTimeouts = {
    ...currentConfiguration(),
    defaultPerNodeTimeoutMs: 0,
    gitCloneTimeoutMs: -1,
    scriptDepsInstallTimeoutMs: 0,
    scriptInterpreters: {},
  }
  const actual = await resolveTaskLaunchRuntimeConfiguration({ read: () => invalidTimeouts })
  expect(actual.defaultPerNodeTimeoutMs).toBeUndefined()
  expect(actual.cloneTimeoutMs).toBeUndefined()
  expect(actual.scriptDepsInstallTimeoutMs).toBeUndefined()
  expect(actual.scriptInterpreters).toBeUndefined()
  expect(actual.gitBaselineSyncWindowMs).toBe(0)
})

test('selected capture and upload reads await, stay live, and preserve independent defaults', async () => {
  const entered = barrier(),
    release = barrier()
  let current = currentConfiguration(),
    reads = 0,
    settled = false
  const queries: TaskLaunchConfigurationQueries = {
    async read() {
      reads++
      if (reads === 1) {
        entered.release()
        await release.pending
      }
      return current
    },
  }
  const first = resolveTaskUploadLimits(queries, DEFAULT_UPLOAD_LIMITS).then((value) => {
    settled = true
    return value
  })
  try {
    await entered.pending
    expect(settled).toBe(false)
    release.release()
    const initial = await first
    expect(initial).toEqual(current.uploadLimits)
    current = { ...current, uploadLimits: { perFile: 432, perRequest: 765, perCount: 4 } }
    expect(await resolveTaskUploadLimits(queries, DEFAULT_UPLOAD_LIMITS)).toEqual(
      current.uploadLimits,
    )
    expect(initial).toEqual({ perFile: 321, perRequest: 654, perCount: 3 })
    expect(await resolveTaskSubagentLiveCapture(queries)).toEqual(current.subagentLiveCapture)
    const failed: TaskLaunchConfigurationQueries = {
      async read() {
        throw new Error('selected source offline')
      },
    }
    const fallback = await resolveTaskUploadLimits(failed, DEFAULT_UPLOAD_LIMITS)
    expect(fallback).toEqual(DEFAULT_UPLOAD_LIMITS)
    expect(fallback).not.toBe(DEFAULT_UPLOAD_LIMITS)
    expect(await resolveTaskSubagentLiveCapture(failed)).toBeUndefined()
  } finally {
    release.release()
    await first.catch(() => {})
  }
})

describeEachProvider('RFC-370 launch configuration adapters', (harness) => {
  test('standalone entry points keep synchronous values, per-call hot reads and complete start deps', () => {
    const home = temporaryHome(),
      configPath = join(home, 'config.json')
    const current = currentConfiguration()
    writeFileSync(configPath, JSON.stringify(current))
    const first = resolveLaunchRuntimeConfig(configPath)
    expect(first).not.toBeInstanceOf(Promise)
    expect(first.defaultRuntime).toBe('runtime-live')
    expect(resolveCommitPushConfig(configPath)?.lang).toBe('zh-CN')
    expect(resolveSubagentLiveCapture(configPath)).toEqual(current.subagentLiveCapture)
    expect(resolveUploadLimits(configPath)).toEqual(current.uploadLimits)
    const deps = buildStartTaskDeps(harness.db, createNoopSchedulerDriver(), configPath, 'owner')
    expect(deps.defaultRuntime).toBe('runtime-live')
    expect(deps.subagentLiveCapture).toEqual(current.subagentLiveCapture)
    writeFileSync(
      configPath,
      JSON.stringify({
        ...current,
        defaultRuntime: 'runtime-after-a-long-edit',
        subagentLiveCapture: { pollMs: 3333, consecutiveFailureLimit: 7 },
      }),
    )
    expect(resolveLaunchRuntimeConfig(configPath).defaultRuntime).toBe('runtime-after-a-long-edit')
    expect(resolveSubagentLiveCapture(configPath)).toEqual({
      pollMs: 3333,
      consecutiveFailureLimit: 7,
    })
    expect(first.defaultRuntime).toBe('runtime-live')
    writeFileSync(configPath, '{')
    expect(resolveCommitPushConfig(configPath)).toBeUndefined()
    expect(resolveLaunchRuntimeConfig(configPath)).toEqual({})
    expect(resolveSubagentLiveCapture(configPath)).toBeUndefined()
    expect(resolveUploadLimits(configPath)).toEqual(DEFAULT_UPLOAD_LIMITS)
  })

  test('the selected source wins over the legacy refresher and is reread for each drive', async () => {
    const home = temporaryHome(),
      configPath = join(home, 'absent', 'config.json'),
      entered = barrier(),
      release = barrier()
    let current = currentConfiguration(),
      reads = 0,
      localReads = 0,
      settled = false
    const coordinator = createTaskDriveCoordinator({
      deps: { db: harness.db, schedulerDriver: { async drive() {} }, configPath },
      appHome: home,
      launchConfiguration: {
        async read() {
          reads++
          if (reads === 1) {
            entered.release()
            await release.pending
          }
          return current
        },
      },
      refreshLaunchConfig() {
        localReads++
        throw new Error('local refresher must not run')
      },
      engineFailureMessage: 'unexpected engine failure',
      failureReporter: { report() {} },
    })
    const runtimeOf = () =>
      (coordinator as unknown as { options: DefaultTaskDriveCoordinatorOptions }).options.runtime
    const first = Promise.resolve(runtimeOf()).then((value) => {
      settled = true
      return value
    })
    try {
      await entered.pending
      expect(settled).toBe(false)
      release.release()
      expect((await first).runtime.defaultRuntime).toBe('runtime-live')
      expect(reads).toBe(4)
      current = { ...current, defaultRuntime: 'selected-after' }
      const second = await runtimeOf()
      expect(second.runtime.defaultRuntime).toBe('selected-after')
      expect(second.runtime.subagentLiveCapture).toEqual(current.subagentLiveCapture)
      expect(reads).toBe(8)
      expect(localReads).toBe(0)
      expect(existsSync(configPath)).toBe(false)
    } finally {
      release.release()
      await first.catch(() => {})
    }
  })

  for (const failedRead of [undefined, 0, 1, 2]) {
    test(`selected config clears boot values on ${failedRead === undefined ? 'removed optional fields' : `read failure ${failedRead}`}`, async () => {
      let reads = 0
      const removed = {
        ...DEFAULT_CONFIG,
        defaultRuntime: undefined,
        mergeAgentRuntime: undefined,
        mergeAgentModel: undefined,
        scriptInterpreters: {},
        subagentLiveCapture: undefined,
      }
      const coordinator = createTaskDriveCoordinator({
        deps: {
          db: harness.db,
          schedulerDriver: { async drive() {} },
          ...resolveTaskLaunchRuntimeFromReader(currentConfiguration),
          subagentLiveCapture: currentConfiguration().subagentLiveCapture,
          binaryOverride: ['/explicit/binary'],
          configPath: '/explicit/config.json',
        },
        appHome: '/selected',
        launchConfiguration: {
          async read() {
            const index = reads++
            if (index === failedRead) throw new Error(`selected read ${index} failed`)
            return removed
          },
        },
        engineFailureMessage: 'unexpected engine failure',
        failureReporter: { report() {} },
      })
      const resolved = await (
        coordinator as unknown as {
          options: DefaultTaskDriveCoordinatorOptions
        }
      ).options.runtime
      expect(reads).toBe(4)
      expect(resolved.runtime.defaultRuntime).toBeUndefined()
      expect(resolved.runtime.mergeAgentRuntime).toBeUndefined()
      expect(resolved.runtime.mergeAgentModel).toBeUndefined()
      expect(resolved.runtime.scriptInterpreters).toBeUndefined()
      expect(resolved.runtime.subagentLiveCapture).toBeUndefined()
      expect(resolved.runtime.binaryOverride).toEqual(['/explicit/binary'])
      expect(resolved.runtime.configPath).toBe('/explicit/config.json')
      if (failedRead === 0) {
        expect(resolved.runtime.commitPushRuntime).toBeUndefined()
        expect(resolved.runtime.commitPushExcludePatterns).toBeUndefined()
      } else {
        expect(resolved.runtime.commitPushExcludePatterns).toEqual(
          removed.taskCommitExcludePatterns,
        )
      }
      if (failedRead === 1) {
        expect(resolved.runtime.maxConcurrentNodes).toBeUndefined()
        expect(resolved.runtime.defaultNodeRetries).toBeUndefined()
      } else {
        expect(resolved.runtime.maxConcurrentNodes).toBe(removed.maxConcurrentNodes)
        expect(resolved.runtime.defaultNodeRetries).toBe(removed.defaultNodeRetries)
      }
      expect(resolved.runtime.maxActiveChildTasks).toBe(
        failedRead === 2 ? undefined : removed.maxActiveChildTasks,
      )
      expect(resolved.runtime.maxInvocationDepth).toBe(
        failedRead === 2 ? undefined : removed.maxInvocationDepth,
      )
    })
  }

  for (const fail of [false, true]) {
    test(`coordinator waits after attach and releases runtime resolution ${fail ? 'failure' : 'success'}`, async () => {
      const entered = barrier(),
        release = barrier(),
        released = barrier(),
        events: string[] = []
      const runtime = resolveTaskDriveConfig({
        appHome: '/selected',
        defaultRuntime: 'selected-runtime',
      })
      const coordinator = new DefaultTaskDriveCoordinator({
        get runtime() {
          events.push('config')
          entered.release()
          return release.pending.then(() => {
            if (fail) throw new Error('runtime-read-failed')
            return runtime
          })
        },
        lifecycle: {
          async attach(request) {
            events.push('attach')
            return {
              kind: 'attached',
              attachment: {
                execution: createTaskExecutionContext({
                  db: harness.db,
                  intentId: request.intentId,
                  token: createOwnershipToken({
                    taskId: request.taskId,
                    identity: createWorkerIdentity({
                      ownerId: 'owner',
                      daemonGeneration: 'rfc370-launch',
                    }),
                    epoch: 1,
                    leaseUntil: Date.now() + 60000,
                    ownerRevision: 1,
                  }),
                }),
              },
            }
          },
          async releaseAndFinalize() {
            events.push('release')
            released.release()
          },
        },
        admittedContinuation: {
          async run(context) {
            expect(context.runtime).toBe(runtime)
            events.push('admitted')
            return { kind: 'ready' }
          },
        },
        gateContinuationPreDrive: {
          async run() {
            events.push('gate')
            return { kind: 'ready' }
          },
        },
        repositoryPreparation: {
          async run() {
            events.push('prepare')
            return { kind: 'ready' }
          },
        },
        engineOrchestrator: {
          async drive() {
            events.push('engine')
          },
        },
        failureReporter: {
          report({ stage, error }) {
            expect(stage).toBe('drive')
            expect(String(error)).toContain('runtime-read-failed')
            events.push('error')
          },
        },
      })
      const pending = coordinator.submit({
        taskId: 'task',
        intentId: 'intent',
        completionMode: 'background',
      })
      try {
        await entered.pending
        expect(events).toEqual(['attach', 'config'])
        release.release()
        if (fail) {
          await expect(pending).rejects.toThrow('runtime-read-failed')
          expect(events).toEqual(['attach', 'config', 'error', 'release'])
        } else {
          expect(await pending).toEqual({ kind: 'accepted', taskId: 'task' })
          // The background receipt is distinct from final drive settlement.
          await released.pending
          expect(events).toEqual([
            'attach',
            'config',
            'admitted',
            'gate',
            'prepare',
            'engine',
            'release',
          ])
        }
      } finally {
        release.release()
        await pending.catch(() => {})
      }
    })
  }
  test('cancellation while runtime is pending releases the attachment without preparation or dispatch', async () => {
    const entered = barrier(),
      release = barrier(),
      events: string[] = []
    let controller: AbortController | undefined
    const coordinator = new DefaultTaskDriveCoordinator({
      get runtime() {
        entered.release()
        return release.pending.then(() => resolveTaskDriveConfig({ appHome: '/selected' }))
      },
      lifecycle: {
        async attach(request) {
          controller = request.controller
          return {
            kind: 'attached',
            attachment: {
              execution: createTaskExecutionContext({
                db: harness.db,
                intentId: request.intentId,
                token: createOwnershipToken({
                  taskId: request.taskId,
                  identity: createWorkerIdentity({
                    ownerId: 'owner',
                    daemonGeneration: 'rfc370-launch',
                  }),
                  epoch: 1,
                  leaseUntil: Date.now() + 60000,
                  ownerRevision: 1,
                }),
              }),
            },
          }
        },
        async releaseAndFinalize() {
          events.push('release')
        },
      },
      admittedContinuation: {
        async run() {
          throw new Error('cancelled admission ran')
        },
      },
      repositoryPreparation: {
        async run() {
          throw new Error('cancelled preparation ran')
        },
      },
      engineOrchestrator: {
        async drive() {
          throw new Error('cancelled engine ran')
        },
      },
      failureReporter: {
        report() {
          throw new Error('cancellation is not a drive failure')
        },
      },
    })
    const pending = coordinator.submit({
      taskId: 'task',
      intentId: 'intent',
      completionMode: 'await-settle',
    })
    try {
      await entered.pending
      if (controller === undefined) throw new Error('runtime read preceded attach')
      controller.abort()
      release.release()
      expect(await pending).toEqual({ kind: 'settled', taskId: 'task' })
      expect(events).toEqual(['release'])
    } finally {
      release.release()
      await pending.catch(() => {})
    }
  })
})
