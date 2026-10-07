// RFC-370: a Task background lifetime captures its real authority generation.
// These regressions use the actual Task module, both provider persistence
// implementations and the original timers. No replacement scheduler is used.
import { expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG, PROVIDER_SESSION_PAUSE_ABORT_REASON } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners, tasks } from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type { TaskProviderExecutionAuthority } from '@/modules/task-execution/application/ports/taskProviderAuthorityRuntime'
import { TaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { SCHEDULE_TICK_MS } from '@/services/scheduledTaskScheduler'
import { describeEachProvider } from './helpers/eachProvider'
import {
  scheduledTaskRuntime,
  taskExecutionResourceBinding,
} from './helpers/integrationTriggerResourceBinding'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

function fixture(db: ProviderNeutralDatabase, resumeWait?: () => Promise<void>) {
  const module = new TaskExecutionModule('rfc370-authority-background')
  const scheduled = scheduledTaskRuntime(db)
  const persistence = createTaskExecutionPersistence(db)
  const identity = composeIdentityAccess(db)
  const calls = {
    resumed: [] as Array<{ readonly maxPerWindow: number; readonly windowMs: number }>,
    repaired: 0,
  }
  const control = composeTaskExecutionProviderBackground({
    module,
    recovery: persistence.recoveryAdministration,
    taskHasDriver: (taskId) => module.runtimeRegistry.hasTask(taskId),
    buildScheduleLaunch: () => async () => {
      throw new Error('unexpected schedule dispatch')
    },
    autoResume: {
      async run({ breaker }) {
        calls.resumed.push(breaker)
        await resumeWait?.()
        return { resumed: [], skipped: [] }
      },
    },
    lifecycleRepair: {
      async run() {
        calls.repaired++
        return { repaired: [], skipped: [] }
      },
    },
  })
  const dependencies = {
    configuration: { read: async () => DEFAULT_CONFIG },
    scheduled: {
      operations: scheduled.operations,
      identityAccess: {
        delegatedRequests: identity.delegatedRequests,
        integrationTriggerResources: scheduled.integrationTriggerResources,
        taskExecutionResources: taskExecutionResourceBinding(db),
      },
    },
  }
  return { module, control, calls, dependencies, scheduled }
}

type TimeoutSpy = ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>

function fire(timeout: TimeoutSpy, delay: number) {
  const index = timeout.mock.calls.findIndex((args) => args[1] === delay)
  const args = timeout.mock.calls[index]
  const result = timeout.mock.results[index]
  if (args === undefined || result === undefined || result.type !== 'return') {
    throw new Error(`missing timer ${delay}`)
  }
  clearTimeout(result.value)
  const [handler, , ...rest] = args
  if (typeof handler !== 'function') throw new Error('unexpected timer handler')
  Reflect.apply(handler, undefined, rest)
}

async function seedOwnedRuntime(db: ProviderNeutralDatabase, module: TaskExecutionModule) {
  const taskId = 'task-authority-background'
  const slotPath = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-authority-background',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/task-authority-background',
      status: 'pending',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(slotPath),
    })
    .run()
  const intent = await new DrizzleTaskExecutionIntentPersistence(db).submit({
    intentId: 'intent-authority-background',
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'actor-authority-background',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: `${taskId}:root`,
        slotPath,
        operationGeneration: 0,
      },
      payload: {},
    },
  })
  const claim = await module.claim({ db, intentId: intent.intentId })
  const controller = new AbortController()
  expect(
    module.runtimeRegistry.tryAttach({
      token: claim.token,
      intentId: claim.intentId,
      permit: claim.permit,
      controller,
    }),
  ).toBe('attached')
  module.claimGate.leave(claim.permit)
  return { claim, controller, taskId }
}

async function durableRows(db: ProviderNeutralDatabase, taskId: string) {
  return {
    task: await db.select().from(tasks).where(eq(tasks.id, taskId)),
    owner: await db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId)),
    intent: await db
      .select()
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.taskId, taskId)),
  }
}

describeEachProvider('RFC-370 Task background authority lifetime', (harness) => {
  test('invalid selection has zero reads and timers and cannot change the native mode', async () => {
    const f = fixture(harness.db)
    let reads = 0
    const dependencies = {
      ...f.dependencies,
      configuration: {
        async read() {
          reads++
          return DEFAULT_CONFIG
        },
      },
    }
    const timeout = spyOn(globalThis, 'setTimeout')
    try {
      await expect(
        f.control.startAuthority(dependencies, {} as TaskProviderExecutionAuthority),
      ).rejects.toThrow('task-provider-execution-authority-required')
      await expect(
        f.control.startAuthority(dependencies, { current: () => false }),
      ).rejects.toThrow('task-provider-execution-authority-not-current')
      expect(reads).toBe(0)
      expect(timeout).not.toHaveBeenCalled()
      expect(f.calls.resumed).toEqual([])
      await f.control.start(dependencies)
      expect(reads).toBe(1)
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'task-provider-execution-authority-mode-mismatch',
      )
      expect(reads).toBe(1)
    } finally {
      await f.control.stop()
      timeout.mockRestore()
    }
  })

  test('a late startup read cannot resume before the loss notification, and the next grant reads anew', async () => {
    const f = fixture(harness.db)
    const entered = barrier(),
      release = barrier()
    let valid = true,
      reads = 0
    let settings = { ...DEFAULT_CONFIG, autoResumeOnBoot: true, maxAutoRecoveriesPerWindow: 11 }
    const dependencies = {
      ...f.dependencies,
      configuration: {
        async read() {
          reads++
          const captured = settings
          if (reads === 1) {
            entered.release()
            await release.pending
          }
          return captured
        },
      },
    }
    const start = f.control.startAuthority(dependencies, { current: () => valid })
    try {
      await entered.pending
      expect(f.module.claimGate.isPaused).toBe(true)
      valid = false
      release.release()
      const old = await start
      await f.control.awaitIdle()
      expect(f.calls.resumed).toEqual([])
      expect(f.module.claimGate.isPaused).toBe(true)
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'task-provider-execution-authority-drain-pending',
      )
      await old.quiesceAuthorityLoss()
      await old.drain()
      settings = { ...settings, maxAutoRecoveriesPerWindow: 29 }
      await f.control.startAuthority(dependencies, { current: () => true })
      await f.control.awaitIdle()
      expect(reads).toBe(2)
      expect(f.calls.resumed).toEqual([
        { maxPerWindow: 29, windowMs: settings.autoRecoveryWindowMs },
      ])
      await old.pause()
      await old.quiesceAuthorityLoss()
      await old.drain()
      const permit = f.module.claimGate.enter()
      f.module.claimGate.leave(permit)
      await expect(f.control.resume()).rejects.toThrow('task-provider-execution-authority-required')
      await expect(f.control.start(dependencies)).rejects.toThrow(
        'task-provider-execution-authority-mode-mismatch',
      )
    } finally {
      release.release()
      await start
      await f.control.stop()
    }
  })

  test('repair and schedule recheck the original context after held settings reads', async () => {
    const f = fixture(harness.db)
    const entered = barrier(),
      release = barrier()
    let valid = true,
      hold = false,
      heldReads = 0
    const settings = {
      ...DEFAULT_CONFIG,
      autoResumeOnBoot: false,
      autoRepair: { selected: true },
      scheduledTasksEnabled: true,
    }
    const timeout = spyOn(globalThis, 'setTimeout')
    const poll = spyOn(f.scheduled.operations.persistence, 'pollAndClaim')
    try {
      const handle = await f.control.startAuthority(
        {
          ...f.dependencies,
          configuration: {
            async read() {
              if (hold) {
                heldReads++
                if (heldReads === 2) entered.release()
                await release.pending
              }
              return settings
            },
          },
        },
        { current: () => valid },
      )
      hold = true
      fire(timeout, DAEMON_CADENCE.autoRepair)
      fire(timeout, SCHEDULE_TICK_MS)
      await entered.pending
      expect(f.calls.repaired).toBe(0)
      expect(poll).not.toHaveBeenCalled()
      valid = false
      release.release()
      await f.control.awaitIdle()
      expect(f.calls.repaired).toBe(0)
      expect(poll).not.toHaveBeenCalled()
      await handle.quiesceAuthorityLoss()
      await handle.drain()
    } finally {
      release.release()
      await f.control.stop()
      timeout.mockRestore()
      poll.mockRestore()
    }
  })

  test('loss drains real startup and claim ACKs while preserving the durable owner and live runtime', async () => {
    const entered = barrier(),
      release = barrier()
    const f = fixture(harness.db, async () => {
      entered.release()
      await release.pending
    })
    const owned = await seedOwnedRuntime(harness.db, f.module)
    const before = await durableRows(harness.db, owned.taskId)
    let valid = true
    const dependencies = {
      ...f.dependencies,
      configuration: { read: async () => ({ ...DEFAULT_CONFIG, autoResumeOnBoot: true }) },
    }
    const handle = await f.control.startAuthority(dependencies, { current: () => valid })
    await entered.pending
    const permit = f.module.claimGate.enter()
    let drained = false
    valid = false
    const quiesce = handle.quiesceAuthorityLoss()
    const drain = handle.drain().then(() => {
      drained = true
    })
    try {
      expect(f.module.claimGate.isPaused).toBe(true)
      expect(() => f.module.claimGate.enter()).toThrow()
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(owned.controller.signal.aborted).toBe(false)
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'task-provider-execution-authority-drain-pending',
      )
      f.module.claimGate.leave(permit)
      release.release()
      await quiesce
      await drain
      expect(owned.controller.signal.aborted).toBe(false)
      expect(f.module.runtimeRegistry.tokenForTask(owned.taskId)).toBe(owned.claim.token)
      expect(await durableRows(harness.db, owned.taskId)).toEqual(before)
      const next = await f.control.startAuthority(dependencies, { current: () => true })
      await f.control.awaitIdle()
      expect(f.calls.resumed).toHaveLength(1)
      await handle.pause()
      await handle.quiesceAuthorityLoss()
      await handle.drain()
      expect(owned.controller.signal.aborted).toBe(false)
      const newPermit = f.module.claimGate.enter()
      f.module.claimGate.leave(newPermit)
      const aborted = barrier()
      owned.controller.signal.addEventListener('abort', () => aborted.release(), { once: true })
      const normal = next.pause()
      await aborted.pending
      expect(owned.controller.signal.reason).toBe(PROVIDER_SESSION_PAUSE_ABORT_REASON)
      f.module.runtimeRegistry.release({ token: owned.claim.token, controller: owned.controller })
      f.module.runtimeRegistry.settle(owned.claim.token)
      await normal
      await next.drain()
    } finally {
      f.module.claimGate.leave(permit)
      release.release()
      await quiesce
      await drain
      f.module.runtimeRegistry.release({ token: owned.claim.token, controller: owned.controller })
      f.module.runtimeRegistry.settle(owned.claim.token)
      await f.control.stop()
    }
  }, 30_000)

  test('replacement of the input current property cannot rebind the captured receiver', async () => {
    const f = fixture(harness.db)
    let reads = 0
    const authority = {
      active: true,
      current() {
        return this.active
      },
    }
    const timeout = spyOn(globalThis, 'setTimeout')
    try {
      const handle = await f.control.startAuthority(
        {
          ...f.dependencies,
          configuration: {
            async read() {
              reads++
              return { ...DEFAULT_CONFIG, autoResumeOnBoot: false, autoRepair: { selected: true } }
            },
          },
        },
        authority,
      )
      authority.current = () => true
      authority.active = false
      fire(timeout, DAEMON_CADENCE.autoRepair)
      await f.control.awaitIdle()
      expect(reads).toBe(1)
      expect(f.calls.repaired).toBe(0)
      await handle.quiesceAuthorityLoss()
      await handle.drain()
    } finally {
      await f.control.stop()
      timeout.mockRestore()
    }
  })

  test('a pending normal pause and loss have separate real ACKs', async () => {
    const f = fixture(harness.db)
    const entered = barrier(),
      release = barrier()
    let valid = true
    const pause = spyOn(f.module, 'pause')
    const loss = spyOn(f.module, 'quiesceAuthorityLoss')
    const start = f.control.startAuthority(
      {
        ...f.dependencies,
        configuration: {
          async read() {
            entered.release()
            await release.pending
            return { ...DEFAULT_CONFIG, autoResumeOnBoot: true }
          },
        },
      },
      { current: () => valid },
    )
    try {
      await entered.pending
      const normal = f.control.pause()
      valid = false
      const quiesce = f.control.quiesceAuthorityLoss()
      expect(loss).toHaveBeenCalledTimes(3)
      expect(pause).not.toHaveBeenCalled()
      release.release()
      const handle = await start
      await normal
      await quiesce
      await handle.drain()
      expect(pause).toHaveBeenCalledTimes(1)
      expect(pause).toHaveBeenCalledWith(PROVIDER_SESSION_PAUSE_ABORT_REASON)
      expect(loss).toHaveBeenCalledTimes(3)
      expect(f.calls.resumed).toEqual([])
      await f.control.startAuthority(f.dependencies, { current: () => true })
      const permit = f.module.claimGate.enter()
      f.module.claimGate.leave(permit)
    } finally {
      release.release()
      await start
      await f.control.stop()
      pause.mockRestore()
      loss.mockRestore()
    }
  })

  test('read failure really clears its loops before retry and final close retains the original reason', async () => {
    const f = fixture(harness.db)
    const failure = new Error('task selected read failed')
    let reads = 0
    const timeout = spyOn(globalThis, 'setTimeout')
    const clear = spyOn(globalThis, 'clearTimeout')
    const dispose = spyOn(f.module, 'dispose')
    const dependencies = {
      ...f.dependencies,
      configuration: {
        async read() {
          if (++reads === 1) throw failure
          return DEFAULT_CONFIG
        },
      },
    }
    try {
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toBe(
        failure,
      )
      for (const result of timeout.mock.results) {
        if (result.type === 'return') expect(clear).toHaveBeenCalledWith(result.value)
      }
      expect(f.module.claimGate.isPaused).toBe(true)
      expect(f.calls.resumed).toEqual([])
      await f.control.startAuthority(dependencies, { current: () => true })
      expect(reads).toBe(2)
      await f.control.close('selected-task-final-close')
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(dispose).toHaveBeenCalledWith('selected-task-final-close')
    } finally {
      await f.control.stop()
      timeout.mockRestore()
      clear.mockRestore()
      dispose.mockRestore()
    }
  })

  test('a sealed real module rejects startup and clears every owned timer before returning', async () => {
    const f = fixture(harness.db)
    f.module.seal()
    const timeout = spyOn(globalThis, 'setTimeout')
    const clear = spyOn(globalThis, 'clearTimeout')
    const resume = spyOn(f.module, 'resume')
    const dependencies = {
      ...f.dependencies,
      configuration: { read: async () => ({ ...DEFAULT_CONFIG, autoResumeOnBoot: true }) },
    }
    try {
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'sealed',
      )
      expect(resume).toHaveBeenCalledTimes(1)
      expect(timeout.mock.calls.length).toBeGreaterThan(0)
      for (const result of timeout.mock.results) {
        if (result.type === 'return') expect(clear).toHaveBeenCalledWith(result.value)
      }
      expect(f.calls.resumed).toEqual([])
      expect(f.calls.repaired).toBe(0)
      // The failed lifetime is genuinely retired; a retry reaches the same
      // real sealed gate rather than being hidden behind a pending drain.
      await expect(f.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'sealed',
      )
      expect(resume).toHaveBeenCalledTimes(2)
      for (const result of timeout.mock.results) {
        if (result.type === 'return') expect(clear).toHaveBeenCalledWith(result.value)
      }
      expect(f.calls.resumed).toEqual([])
    } finally {
      await f.control.stop()
      timeout.mockRestore()
      clear.mockRestore()
      resume.mockRestore()
    }
  })

  test('a failed runtime receipt ACK retries the original ticket without canceling again', async () => {
    const f = fixture(harness.db)
    const owned = await seedOwnedRuntime(harness.db, f.module)
    const failure = new Error('runtime receipt ACK failed')
    const pause = spyOn(f.module, 'pause')
    const actualStopped = f.module.runtimeRegistry.awaitStopped.bind(f.module.runtimeRegistry)
    const stopped = spyOn(f.module.runtimeRegistry, 'awaitStopped')
      .mockImplementation(async (ticket) => await actualStopped(ticket))
      .mockImplementationOnce(async () => {
        throw failure
      })
    try {
      const handle = await f.control.startAuthority(f.dependencies, { current: () => true })
      await expect(handle.pause()).rejects.toBe(failure)
      expect(owned.controller.signal.aborted).toBe(true)
      expect(owned.controller.signal.reason).toBe(PROVIDER_SESSION_PAUSE_ABORT_REASON)
      expect(pause).toHaveBeenCalledTimes(1)
      await expect(handle.drain()).rejects.toThrow(
        'task-provider-execution-authority-pause-ack-pending',
      )
      const retry = handle.pause()
      f.module.runtimeRegistry.release({ token: owned.claim.token, controller: owned.controller })
      f.module.runtimeRegistry.settle(owned.claim.token)
      await retry
      await handle.drain()
      expect(pause).toHaveBeenCalledTimes(1)
      expect(stopped).toHaveBeenCalledTimes(2)
    } finally {
      f.module.runtimeRegistry.release({ token: owned.claim.token, controller: owned.controller })
      f.module.runtimeRegistry.settle(owned.claim.token)
      await f.control.stop()
      pause.mockRestore()
      stopped.mockRestore()
    }
  })

  test('a failed loss ACK cannot retire a generation and only the missing ACK is retried', async () => {
    const f = fixture(harness.db)
    let valid = true
    const handle = await f.control.startAuthority(f.dependencies, { current: () => valid })
    const failure = new Error('claim drain ACK failed')
    const actualQuiesce = f.module.quiesceAuthorityLoss.bind(f.module)
    const quiesce = spyOn(f.module, 'quiesceAuthorityLoss')
      .mockImplementation(async () => await actualQuiesce())
      .mockImplementationOnce(async () => {
        f.module.claimGate.pause()
        throw failure
      })
    try {
      valid = false
      await expect(handle.quiesceAuthorityLoss()).rejects.toBe(failure)
      expect(f.module.claimGate.isPaused).toBe(true)
      await expect(handle.drain()).rejects.toThrow(
        'task-provider-execution-authority-loss-ack-pending',
      )
      await expect(
        f.control.startAuthority(f.dependencies, { current: () => true }),
      ).rejects.toThrow('task-provider-execution-authority-drain-pending')
      await handle.quiesceAuthorityLoss()
      await handle.drain()
      expect(quiesce).toHaveBeenCalledTimes(2)
      await f.control.startAuthority(f.dependencies, { current: () => true })
      const permit = f.module.claimGate.enter()
      f.module.claimGate.leave(permit)
    } finally {
      await f.control.stop()
      quiesce.mockRestore()
    }
  })
})
