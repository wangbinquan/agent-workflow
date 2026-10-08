import { expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners, tasks } from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { TaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
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

function fixture(db: ProviderNeutralDatabase) {
  const module = new TaskExecutionModule('rfc370-authority-loss')
  const scheduled = scheduledTaskRuntime(db)
  const persistence = createTaskExecutionPersistence(db)
  const identity = composeIdentityAccess(db)
  const calls = { resumed: 0, repaired: 0 }
  const control = composeTaskExecutionProviderBackground({
    module,
    recovery: persistence.recoveryAdministration,
    taskHasDriver: (taskId) => module.runtimeRegistry.hasTask(taskId),
    buildScheduleLaunch: () => async () => {
      throw new Error('unexpected schedule dispatch')
    },
    autoResume: {
      async run() {
        calls.resumed++
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
  return { module, control, calls, dependencies }
}

async function seedOwnedRuntime(db: ProviderNeutralDatabase, module: TaskExecutionModule) {
  const taskId = 'task-authority-loss'
  const slotPath = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-authority-loss',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/task-authority-loss',
      status: 'pending',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(slotPath),
    })
    .run()
  const intent = await new DrizzleTaskExecutionIntentPersistence(db).submit({
    intentId: 'intent-authority-loss',
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'actor-authority-loss',
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

describeEachProvider('RFC-370 authority-loss Task quiesce', (harness) => {
  test('closes new claims synchronously, drains admitted permits and preserves the durable owner and live runtime', async () => {
    const f = fixture(harness.db)
    const { claim, controller, taskId } = await seedOwnedRuntime(harness.db, f.module)
    const heldPermit = f.module.claimGate.enter()
    const before = {
      task: await harness.db.select().from(tasks).where(eq(tasks.id, taskId)),
      owner: await harness.db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, taskId)),
      intent: await harness.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.taskId, taskId)),
    }
    let drained = false
    const pending = f.control.quiesceAuthorityLoss().then(() => {
      drained = true
    })
    try {
      expect(f.module.claimGate.isPaused).toBe(true)
      expect(() => f.module.claimGate.enter()).toThrow()
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(controller.signal.aborted).toBe(false)
      f.module.claimGate.leave(heldPermit)
      await pending
      expect(controller.signal.aborted).toBe(false)
      expect(f.module.runtimeRegistry.tokenForTask(taskId)).toBe(claim.token)
      expect({
        task: await harness.db.select().from(tasks).where(eq(tasks.id, taskId)),
        owner: await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, taskId)),
        intent: await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, taskId)),
      }).toEqual(before)
      await f.control.resume()
      const reopened = f.module.claimGate.enter()
      f.module.claimGate.leave(reopened)
      const originalPause = await f.module.pause('ordinary-provider-pause')
      expect(originalPause).toHaveLength(1)
      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toBe('ordinary-provider-pause')
    } finally {
      f.module.claimGate.leave(heldPermit)
      await pending
      f.module.runtimeRegistry.release({ token: claim.token, controller })
      f.module.runtimeRegistry.settle(claim.token)
      await f.control.stop()
    }
  }, 30_000)

  test('waits for a pending startup query without starting native auto-resume after loss', async () => {
    const f = fixture(harness.db),
      entered = barrier(),
      release = barrier()
    const start = f.control.start({
      ...f.dependencies,
      configuration: {
        async read() {
          entered.release()
          await release.pending
          return { ...DEFAULT_CONFIG, autoResumeOnBoot: true }
        },
      },
    })
    let drained = false
    try {
      await entered.pending
      const loss = f.control.quiesceAuthorityLoss().then(() => {
        drained = true
      })
      expect(() => f.module.claimGate.enter()).toThrow()
      await Promise.resolve()
      expect(drained).toBe(false)
      release.release()
      await start
      await loss
      expect(f.calls).toEqual({ resumed: 0, repaired: 0 })
      expect(await harness.db.select().from(taskExecutionIntents)).toEqual([])
    } finally {
      release.release()
      await start
      await f.control.stop()
    }
  }, 30_000)

  test('a tick whose settings ACK arrives after loss is drained before reopening and does not dispatch', async () => {
    const f = fixture(harness.db),
      entered = barrier(),
      release = barrier()
    const timers = spyOn(globalThis, 'setTimeout')
    let reads = 0
    const configuration = {
      async read() {
        if (reads++ > 0) {
          entered.release()
          await release.pending
        }
        return { ...DEFAULT_CONFIG, autoRepair: { selected: true } }
      },
    }
    try {
      await f.control.start({ ...f.dependencies, configuration })
      const index = timers.mock.calls.findIndex((args) => args[1] === DAEMON_CADENCE.autoRepair)
      const args = timers.mock.calls[index],
        result = timers.mock.results[index]
      if (args === undefined || result === undefined || result.type !== 'return')
        throw new Error('auto-repair timer not registered')
      clearTimeout(result.value)
      const [handler, , ...rest] = args
      if (typeof handler !== 'function') throw new Error('unexpected timer handler')
      Reflect.apply(handler, undefined, rest)
      await entered.pending
      let drained = false
      const loss = f.control.quiesceAuthorityLoss().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(f.calls.repaired).toBe(0)
      release.release()
      await loss
      expect(f.calls.repaired).toBe(0)
      expect(() => f.module.claimGate.enter()).toThrow()
      await f.control.resume()
      const permit = f.module.claimGate.enter()
      f.module.claimGate.leave(permit)
    } finally {
      release.release()
      await f.control.stop()
      timers.mockRestore()
    }
  }, 30_000)

  test('an already queued resume cannot reopen claims after a newer loss', async () => {
    const f = fixture(harness.db),
      entered = barrier(),
      release = barrier()
    const start = f.control.start({
      ...f.dependencies,
      configuration: {
        async read() {
          entered.release()
          await release.pending
          return DEFAULT_CONFIG
        },
      },
    })
    try {
      await entered.pending
      const pause = f.control.pause()
      const staleResume = f.control.resume()
      // The rejection matcher waits synchronously in Bun; do not block the release below.
      void staleResume.catch(() => undefined)
      const loss = f.control.quiesceAuthorityLoss()
      release.release()
      await start
      await pause
      await expect(staleResume).rejects.toThrow('task-execution-provider-authority-quiesced')
      await loss
      expect(() => f.module.claimGate.enter()).toThrow()
      await f.control.resume()
      const permit = f.module.claimGate.enter()
      f.module.claimGate.leave(permit)
    } finally {
      release.release()
      await start
      await f.control.stop()
    }
  }, 30_000)
})
