// RFC-370: provider-session writers await their selected settings, keep each
// tick live, and include pending startup reads/recovery in pause/stop drains.
// The real provider persistence and TaskExecutionModule are used; timers are
// manually fired from a passthrough spy, without waiting five minutes.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { TaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { TaskBackgroundConfigurationQuery } from '@/modules/task-execution/application/ports/taskBackgroundConfiguration'
import type { TaskLifecycleAutoRepairPolicy } from '@/modules/task-execution/application/ports/taskLifecycleAutoRepairCommand'
import { createFileTaskBackgroundConfigurationQuery } from '@/modules/task-execution/infrastructure/local/fileTaskBackgroundConfiguration'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { SCHEDULE_TICK_MS } from '@/services/scheduledTaskScheduler'
import { describeEachProvider } from './helpers/eachProvider'
import {
  scheduledTaskRuntime,
  taskExecutionResourceBinding,
} from './helpers/integrationTriggerResourceBinding'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

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

function fixture(
  db: PersistenceDb,
  resumeWait?: () => Promise<void>,
  recoveryTick?: () => Promise<void>,
) {
  const module = new TaskExecutionModule('rfc370-background')
  const scheduled = scheduledTaskRuntime(db)
  const recovery = createTaskExecutionPersistence(db).recoveryAdministration
  const identity = composeIdentityAccess(db)
  const calls = {
    resumed: [] as Array<{ readonly maxPerWindow: number; readonly windowMs: number }>,
    repaired: [] as TaskLifecycleAutoRepairPolicy[],
  }
  const control = composeTaskExecutionProviderBackground({
    ...(recoveryTick ? { recoveryConsumer: { tick: recoveryTick } } : {}),
    module,
    recovery,
    taskHasDriver: () => false,
    buildScheduleLaunch: () => async () => {
      throw new Error('unexpected schedule launch')
    },
    autoResume: {
      async run({ breaker }) {
        calls.resumed.push(breaker)
        await resumeWait?.()
        return { resumed: [], skipped: [] }
      },
    },
    lifecycleRepair: {
      async run(policy) {
        calls.repaired.push(policy)
        return { repaired: [], skipped: [] }
      },
    },
  })
  const scheduleDependencies = {
    operations: scheduled.operations,
    identityAccess: {
      delegatedRequests: identity.delegatedRequests,
      integrationTriggerResources: scheduled.integrationTriggerResources,
      taskExecutionResources: taskExecutionResourceBinding(db),
    },
  }
  return { control, module, calls, recovery, scheduled, scheduleDependencies }
}

describeEachProvider('RFC-370 Task background selected settings', (harness) => {
  test('hosted recovery shares provider pause, drain, resume and final stop', async () => {
    const timeout = spyOn(globalThis, 'setTimeout')
    const entered = barrier(),
      release = barrier()
    let ticks = 0
    const { control, scheduleDependencies } = fixture(harness.db, undefined, async () => {
      ticks++
      if (ticks === 1) {
        entered.release()
        await release.pending
      }
    })
    const lastRecoveryTick = () => {
      const index =
        timeout.mock.calls
          .map((args, index) => (args[1] === 5000 ? index : -1))
          .filter((index) => index >= 0)
          .at(-1) ?? -1
      const args = timeout.mock.calls[index],
        result = timeout.mock.results[index]
      if (!args || result?.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('recovery timer absent')
      clearTimeout(result.value)
      return () => Reflect.apply(args[0] as (...args: unknown[]) => void, undefined, args.slice(2))
    }
    try {
      await control.start({
        configuration: { read: async () => ({ ...DEFAULT_CONFIG, autoResumeOnBoot: false }) },
        scheduled: scheduleDependencies,
      })
      const first = lastRecoveryTick()
      first()
      await entered.pending
      let paused = false
      const drain = control.pause().then(() => {
        paused = true
      })
      await Promise.resolve()
      expect(paused).toBe(false)
      release.release()
      await drain
      first()
      expect(ticks).toBe(1)
      await control.resume()
      const second = lastRecoveryTick()
      second()
      await control.awaitIdle()
      expect(ticks).toBe(2)
      await control.stop()
      second()
      expect(ticks).toBe(2)
      await expect(control.resume()).rejects.toThrow()
    } finally {
      release.release()
      await control.stop()
      timeout.mockRestore()
    }
  })
  test('startup waits for settings, recovery stays detached, and pause drains both', async () => {
    const readEntered = barrier(),
      readRelease = barrier(),
      resumeEntered = barrier(),
      resumeRelease = barrier()
    const { control, module, calls, scheduleDependencies } = fixture(harness.db, async () => {
      resumeEntered.release()
      await resumeRelease.pending
    })
    let started = false,
      paused = false
    const current = { ...DEFAULT_CONFIG, autoResumeOnBoot: true, maxAutoRecoveriesPerWindow: 7 }
    const start = control
      .start({
        configuration: {
          async read() {
            readEntered.release()
            await readRelease.pending
            return current
          },
        },
        scheduled: scheduleDependencies,
      })
      .then(() => {
        started = true
      })
    try {
      await readEntered.pending
      expect(started).toBe(false)
      expect(calls.resumed).toEqual([])
      const pause = control.pause().then(() => {
        paused = true
      })
      await Promise.resolve()
      expect(paused).toBe(false)
      readRelease.release()
      await resumeEntered.pending
      await start
      expect(started).toBe(true)
      expect(paused).toBe(false)
      expect(calls.resumed).toEqual([{ maxPerWindow: 7, windowMs: current.autoRecoveryWindowMs }])
      resumeRelease.release()
      await pause
      expect(() => module.claimGate.enter()).toThrow()
      await control.resume()
      const permit = module.claimGate.enter()
      module.claimGate.leave(permit)
      expect(calls.resumed).toHaveLength(1)
    } finally {
      readRelease.release()
      resumeRelease.release()
      await start
      await control.stop()
    }
  })

  test('each tick waits and sees current settings; selected schedule ignores the legacy reader', async () => {
    const { control, calls, recovery, scheduled, scheduleDependencies } = fixture(harness.db)
    const timeout = spyOn(globalThis, 'setTimeout')
    const stalled = spyOn(recovery, 'listStalledRunningChildren')
    const poll = spyOn(scheduled.operations.persistence, 'pollAndClaim')
    let current = {
      ...DEFAULT_CONFIG,
      autoRepair: { selected: true },
      autoKillStalledChild: true,
      periodicOrphanReconcileMs: 0,
      scheduledTasksEnabled: true,
      maxAutoRecoveriesPerWindow: 7,
      heartbeatStallMs: 123_000,
    }
    let readRelease: ReturnType<typeof barrier> | undefined
    let readEntered: ReturnType<typeof barrier> | undefined
    let legacyReads = 0
    const configuration: TaskBackgroundConfigurationQuery = {
      async read() {
        readEntered?.release()
        await readRelease?.pending
        return current
      },
    }
    function fire(delay: number, occurrence = 0) {
      const matching = timeout.mock.calls.flatMap((args, index) =>
        args[1] === delay ? [index] : [],
      )
      const index = matching[occurrence]
      if (index === undefined) throw new Error(`missing timer ${delay}/${occurrence}`)
      const args = timeout.mock.calls[index]
      const result = timeout.mock.results[index]
      if (args === undefined || result === undefined || result.type !== 'return')
        throw new Error('timer not registered')
      clearTimeout(result.value)
      const [handler, , ...rest] = args
      if (typeof handler !== 'function') throw new Error('unexpected timer handler')
      Reflect.apply(handler, undefined, rest)
    }
    async function heldTick(delay: number, occurrence: number, assertBefore: () => void) {
      readEntered = barrier()
      readRelease = barrier()
      fire(delay, occurrence)
      await readEntered.pending
      assertBefore()
      let idle = false
      const pending = control.awaitIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      readRelease.release()
      await pending
      readEntered = undefined
      readRelease = undefined
    }
    try {
      await control.start({
        configuration,
        scheduled: {
          ...scheduleDependencies,
          loadConfig: () => {
            legacyReads++
            return DEFAULT_CONFIG
          },
        },
      })
      await heldTick(DAEMON_CADENCE.autoRepair, 0, () => expect(calls.repaired).toEqual([]))
      expect(calls.repaired).toEqual([
        { enabledRules: ['selected'], maxPerWindow: 7, windowMs: current.autoRecoveryWindowMs },
      ])
      current = { ...current, autoRepair: { selected: false }, maxAutoRecoveriesPerWindow: 9 }
      await heldTick(DAEMON_CADENCE.autoRepair, 2, () => expect(calls.repaired).toHaveLength(1))
      expect(calls.repaired).toHaveLength(1)
      await heldTick(DAEMON_CADENCE.autoKill, 1, () => expect(stalled).not.toHaveBeenCalled())
      expect(stalled).toHaveBeenCalledTimes(1)
      expect(stalled.mock.calls[0]?.[0].stallMs).toBe(123_000)
      await heldTick(DAEMON_CADENCE.orphanReconcileSupervisory, 0, () =>
        expect(poll).not.toHaveBeenCalled(),
      )
      await heldTick(SCHEDULE_TICK_MS, 0, () => expect(poll).not.toHaveBeenCalled())
      expect(poll).toHaveBeenCalledTimes(1)
      expect(legacyReads).toBe(0)
    } finally {
      readRelease?.release()
      await control.stop()
      timeout.mockRestore()
      stalled.mockRestore()
      poll.mockRestore()
    }
  })

  test('selected startup failure propagates without local fallback or recovery', async () => {
    const { control, calls, scheduleDependencies } = fixture(harness.db)
    const root = mkdtempSync(join(tmpdir(), 'aw-background-selected-'))
    directories.push(root)
    const path = join(root, 'absent-home', 'config.json')
    const failure = new Error('selected config unavailable')
    try {
      await expect(
        control.start({
          configPath: path,
          configuration: {
            read: async () => {
              throw failure
            },
          },
          scheduled: scheduleDependencies,
        }),
      ).rejects.toBe(failure)
      expect(calls.resumed).toEqual([])
      expect(existsSync(path)).toBe(false)
      await control.awaitIdle()
    } finally {
      await control.stop()
    }
  })
})

test('local background query preserves live file reads and default values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-background-file-'))
  directories.push(root)
  const path = join(root, 'config.json')
  const query = createFileTaskBackgroundConfigurationQuery(path)
  expect((await query.read()).autoResumeOnBoot).toBe(false)
  writeFileSync(
    path,
    JSON.stringify({ ...DEFAULT_CONFIG, autoResumeOnBoot: true, maxAutoRecoveriesPerWindow: 7 }),
  )
  expect((await query.read()).maxAutoRecoveriesPerWindow).toBe(7)
  writeFileSync(
    path,
    JSON.stringify({ ...DEFAULT_CONFIG, autoResumeOnBoot: false, maxAutoRecoveriesPerWindow: 9 }),
  )
  expect((await query.read()).maxAutoRecoveriesPerWindow).toBe(9)
})
