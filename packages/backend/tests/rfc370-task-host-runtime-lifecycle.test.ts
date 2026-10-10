// RFC-370 L: the original lifecycle transactions and the actual finite callers.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import ts from 'typescript'
import { format } from 'prettier'
import {
  isDaemonInterruptionAbortReason,
  DAEMON_SHUTDOWN_ABORT_REASON,
  DAEMON_RESTART_ERROR_SUMMARY,
  type TaskStatus,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  tasks,
  taskExecutionOwners,
  committedEvents,
  recoveryEvents,
  taskExecutionIntents,
} from '@/db/schema'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskHostExecutionAdmission } from '@/modules/task-execution/composition/hostExecutionAdmission'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { DrizzleTaskRuntimeLifecyclePersistence } from '@/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence'
import * as lifecycleEvents from '@/modules/task-execution/infrastructure/taskLifecycleCommittedEvents'
import { selectTaskRuntimeLifecycleWrites } from '@/modules/task-execution/public/participants'
import { taskStopProjection } from '@/modules/task-execution/public/types'
import {
  createTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import type { TaskRuntimeLifecyclePersistence } from '@/modules/task-execution/application/ports/taskRuntimeLifecyclePersistence'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import type { TaskExecutionContextRef } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
  type TaskDriveFailureReporter,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import type { TaskHostWriteBinding } from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import {
  databaseTransactionIsActive,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskHostFixture,
  additionalTaskHostFixture,
  deferred,
  nextTurn,
} from './helpers/taskHostExecution'
import originalCallers from './fixtures/rfc370-task-runtime-lifecycle-original-callers.json'
import { inverseTaskRuntimeLifecycleRootSelections } from './helpers/taskLaunchRootStatementInverse'

const modules: { resetForTesting(): void }[] = []
const spies: { mockRestore(): void }[] = []
afterEach(() => {
  registerAfterCommitEventPump(null)
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})
const purposes = ['preparation', 'issuedResults'] as const
type Purpose = (typeof purposes)[number]
type Mutation = Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0]

async function fixture(db: ProviderNeutralDatabase) {
  const taskId = `lifecycle-${ulid()}`
  const h = await taskHostFixture(db, taskId)
  modules.push(h.module)
  const calls = { preparation: 0, issuedResults: 0 }
  const controls: {
    reject?: Error
    beforeConsume?: (purpose: Purpose) => Promise<void>
    exists?: (reference: string) => Promise<boolean>
  } = {}
  const transactions: DatabaseTransaction[] = []
  const port = h.binding.port
  const binding: TaskHostWriteBinding = {
    transactionFor(tx) {
      expect(this).toBe(binding)
      expect(databaseTransactionIsActive(tx)).toBe(true)
      transactions.push(tx)
      return h.binding.transactionFor.call(h.binding, tx)
    },
    port: {
      capture(input) {
        return port.capture.call(port, input)
      },
      consumeRecovery(...args) {
        return port.consumeRecovery.call(port, ...args)
      },
      async consumeNewWork(...args) {
        calls.preparation++
        await controls.beforeConsume?.('preparation')
        if (controls.reject !== undefined) throw controls.reject
        await port.consumeNewWork.call(port, ...args)
      },
      async consumeIssuedAck(...args) {
        calls.issuedResults++
        await controls.beforeConsume?.('issuedResults')
        if (controls.reject !== undefined) throw controls.reject
        await port.consumeIssuedAck.call(port, ...args)
      },
    },
  }
  const presence = {
    async exists(reference: string) {
      expect(this).toBe(presence)
      return controls.exists === undefined ? true : await controls.exists(reference)
    },
  }
  const persistence = createTaskExecutionPersistence(db, {
    hostWrites: binding,
    workspacePresence: presence,
  })
  const host = {
    admission: composeTaskHostExecutionAdmission({ admission: h.source, writes: binding.port }),
    writes: binding,
  }
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `lifecycle-daemon-${taskId}`,
    persistence,
    host,
  })
  modules.push(module)
  const claim = () => module.claimPersisted({ intentId: h.intentId })
  const lifecycle = createTaskDriverLifecyclePort({
    db,
    module,
    claim,
    persistence,
    log: createLogger('rfc370-lifecycle-test'),
    finalizeWorkspace: async () => {},
    legacyConnection: db,
  })
  const task = () => db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  const owners = () =>
    db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId)).all()
  const events = () => db.select().from(committedEvents).orderBy(committedEvents.id).all()
  return {
    db,
    h,
    taskId,
    persistence,
    module,
    claim,
    lifecycle,
    binding,
    presence,
    calls,
    controls,
    transactions,
    task,
    owners,
    events,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function claimedFixture(db: ProviderNeutralDatabase) {
  const f = await fixture(db)
  const claimed = await f.claim()
  f.module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)
  if (work === undefined) throw new Error('original-lifecycle-work-missing')
  const context = createTaskExecutionContext({
    intentId: f.h.intentId,
    token: claimed.token,
    persistence: f.persistence,
    legacyConnection: db,
    compatibility: { db },
    hostWriteCapture: taskHostWorkCapture(work),
  })
  await db
    .update(tasks)
    .set({
      status: 'running',
      runningSince: 100,
      runningMs: 5,
      lifecycleEventRevision: 7,
      spaceKind: 'scratch',
    })
    .where(eq(tasks.id, f.taskId))
  f.calls.preparation = 0
  f.calls.issuedResults = 0
  f.transactions.length = 0
  return { ...f, context, work }
}
type ClaimedFixture = Awaited<ReturnType<typeof claimedFixture>>

function input(f: ClaimedFixture, to: TaskStatus = 'failed'): Mutation {
  return {
    taskId: f.taskId,
    to,
    allowedFrom: ['running'],
    extra: {
      finishedAt: 300,
      errorSummary: 'original result',
      errorMessage: 'original detail',
      failedNodeId: 'original-node',
    },
    executionContext: f.context,
    now: 300,
    reason: 'original-lifecycle-result',
  }
}
function write(f: ClaimedFixture, purpose: Purpose, mutation = input(f)) {
  return runWithTaskExecutionContext(f.context, () =>
    selectTaskRuntimeLifecycleWrites(f.persistence, purpose).trySet(mutation),
  )
}
async function snapshot(f: Fixture) {
  return { task: await f.task(), owners: await f.owners(), events: await f.events() }
}
function causes(error: unknown): unknown[] {
  const chain: unknown[] = []
  while (error !== undefined && !chain.includes(error)) {
    chain.push(error)
    error =
      typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
  }
  return chain
}
async function rejection(pending: Promise<unknown>) {
  const outcome = await pending.then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  )
  expect(outcome.failed).toBe(true)
  if (!outcome.failed) throw new Error('expected-original-lifecycle-rejection')
  return outcome.error
}

describeEachProvider('RFC-370 Task runtime lifecycle keeps original transactions', (harness) => {
  test('native selection retains its original instance and guard while selected views remain distinct', async () => {
    const f = await claimedFixture(harness.db)
    const native = createTaskExecutionPersistence(harness.db)
    expect(native.runtimeLifecycle).toBeInstanceOf(DrizzleTaskRuntimeLifecyclePersistence)
    for (const purpose of purposes)
      expect(selectTaskRuntimeLifecycleWrites(native, purpose)).toBe(native.runtimeLifecycle)
    expect(f.persistence.runtimeLifecycle).toBeInstanceOf(DrizzleTaskRuntimeLifecyclePersistence)
    const views = f.persistence.runtimeLifecycleWritePurposes!
    expect(Object.isFrozen(views)).toBe(true)
    expect(Object.isFrozen(views.preparation)).toBe(true)
    expect(Object.isFrozen(views.issuedResults)).toBe(true)
    expect(views.preparation).not.toBe(views.issuedResults)
    for (const purpose of purposes) {
      expect(Object.keys(views[purpose])).toEqual(['trySet'])
      expect(() =>
        selectTaskRuntimeLifecycleWrites(
          { ...native, runtimeLifecycleWriteMode: 'host-selected' },
          purpose,
        ),
      ).toThrow('task-runtime-lifecycle-write-purposes-not-composed')
    }
    const before = await snapshot(f)
    const guarded = native.runtimeLifecycle as DrizzleTaskRuntimeLifecyclePersistence
    const error = new ConflictError('original-guard-reject', 'original guard')
    expect(
      await guarded.trySetWithGuard(input(f), async (tx) => {
        expect(databaseTransactionIsActive(tx)).toBe(true)
        throw error
      }),
    ).toBe(false)
    expect(await snapshot(f)).toEqual(before)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
  })

  for (const purpose of purposes) {
    test(`${purpose}: real Task, original owner increment and event share one actual transaction`, async () => {
      const f = await claimedFixture(harness.db)
      const before = await snapshot(f)
      expect(await write(f, purpose)).toBe(true)
      expect(await f.task()).toMatchObject({
        status: 'failed',
        finishedAt: 300,
        errorSummary: 'original result',
        errorMessage: 'original detail',
        failedNodeId: 'original-node',
        runningMs: 205,
        runningSince: null,
        lifecycleEventRevision: 8,
      })
      expect(await f.owners()).toEqual(
        before.owners.map((owner) => ({ ...owner, revision: owner.revision + 1, updatedAt: 300 })),
      )
      expect(await f.events()).toHaveLength(before.events.length + 1)
      expect(f.calls[purpose]).toBe(1)
      expect(f.calls[purpose === 'preparation' ? 'issuedResults' : 'preparation']).toBe(0)
      expect(f.transactions).toHaveLength(1)
      if (harness.capabilities.isolation === 'exclusive') expect(f.transactions[0]).toBe(harness.db)
      else expect(f.transactions[0]).not.toBe(harness.db)
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
    })

    test(`${purpose}: host rejection rolls back Task, owner and event, then retries the same original work`, async () => {
      const f = await claimedFixture(harness.db)
      const before = await snapshot(f)
      const error = new Error('original-host-result-rejected')
      f.controls.reject = error
      expect(causes(await rejection(write(f, purpose)))).toContain(error)
      expect(await snapshot(f)).toEqual(before)
      delete f.controls.reject
      expect(await write(f, purpose)).toBe(true)
      expect(f.calls[purpose]).toBe(2)
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
      expect(await f.owners()).toEqual(
        before.owners.map((owner) => ({ ...owner, revision: owner.revision + 1, updatedAt: 300 })),
      )
      expect(await f.events()).toHaveLength(before.events.length + 1)
    })

    test(`${purpose}: original from and missing Task conflicts remain false before host consumption`, async () => {
      const f = await claimedFixture(harness.db)
      const before = await snapshot(f)
      expect(await write(f, purpose, { ...input(f), allowedFrom: ['pending'] })).toBe(false)
      expect(await snapshot(f)).toEqual(before)
      await harness.db.delete(tasks).where(eq(tasks.id, f.taskId))
      expect(await write(f, purpose)).toBe(false)
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
      expect(f.transactions).toEqual([])
    })

    test(`${purpose}: original owner and SQL failures precede host consumption and roll back`, async () => {
      const f = await claimedFixture(harness.db)
      const before = await snapshot(f)
      const sqlError = await rejection(
        write(f, purpose, { ...input(f), to: null as unknown as TaskStatus }),
      )
      expect(
        causes(sqlError).some(
          (cause) => cause instanceof Error && /not.null|null value/i.test(cause.message),
        ),
      ).toBe(true)
      expect(await snapshot(f)).toEqual(before)
      expect(f.calls[purpose]).toBe(0)
      await harness.db
        .update(taskExecutionOwners)
        .set({ ownerId: 'original-different-owner' })
        .where(eq(taskExecutionOwners.taskId, f.taskId))
      const changedOwner = await snapshot(f)
      const ownerError = await rejection(write(f, purpose))
      expect(
        causes(ownerError).some(
          (cause) =>
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'task-execution-stale-owner',
        ),
      ).toBe(true)
      expect(await snapshot(f)).toEqual(changedOwner)
      expect(f.calls[purpose]).toBe(0)
    })

    test(`${purpose}: a failure after the original event append rolls back its real rows before consume`, async () => {
      const f = await claimedFixture(harness.db)
      const before = await snapshot(f)
      const error = new Error('original-lifecycle-event-append-failed')
      const append = lifecycleEvents.appendTaskLifecycleTransitionCommittedEvent
      const spy = spyOn(
        lifecycleEvents,
        'appendTaskLifecycleTransitionCommittedEvent',
      ).mockImplementation(async (...args: Parameters<typeof append>) => {
        await append(...args)
        throw error
      })
      spies.push(spy)
      expect(causes(await rejection(write(f, purpose)))).toContain(error)
      expect(await snapshot(f)).toEqual(before)
      expect(f.calls[purpose]).toBe(0)
    })
  }

  test('selected valid writes require their original Task capture and never use the native entry', async () => {
    const f = await claimedFixture(harness.db)
    const before = await snapshot(f)
    for (const purpose of purposes) {
      const mutation = input(f)
      const { executionContext: _context, ...withoutContext } = mutation
      expect(
        causes(
          await rejection(
            selectTaskRuntimeLifecycleWrites(f.persistence, purpose).trySet(withoutContext),
          ),
        ).some(
          (cause) =>
            cause instanceof Error && cause.message === 'task-host-execution-context-required',
        ),
      ).toBe(true)
    }
    expect(await snapshot(f)).toEqual(before)
    expect(f.transactions).toEqual([])
  })

  test('selected views keep the saved original lifecycle method and receiver after method replacement', async () => {
    const f = await claimedFixture(harness.db)
    const native = f.persistence.runtimeLifecycle as DrizzleTaskRuntimeLifecyclePersistence
    const replacement = spyOn(native, 'trySetWithHostWrite').mockImplementation(async () => {
      throw new Error('later-lifecycle-method-must-not-run')
    })
    spies.push(replacement)
    expect(await write(f, 'issuedResults')).toBe(true)
    expect(replacement).not.toHaveBeenCalled()
    expect(await f.task()).toMatchObject({ status: 'failed', lifecycleEventRevision: 8 })
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })

  test('a real native Task claim cannot substitute for the selected original admitted work', async () => {
    const f = await fixture(harness.db)
    const native = createTaskExecutionPersistence(harness.db)
    const module = createProviderTaskExecutionModule({
      daemonGeneration: `native-lifecycle-${f.taskId}`,
      persistence: native,
    })
    modules.push(module)
    const claimed = await module.claimPersisted({ intentId: f.h.intentId })
    module.claimGate.leave(claimed.permit)
    expect(taskHostWorkForToken(claimed.token)).toBeUndefined()
    const context = createTaskExecutionContext({
      intentId: f.h.intentId,
      token: claimed.token,
      persistence: native,
      legacyConnection: harness.db,
    })
    const mutation: Mutation = {
      taskId: f.taskId,
      to: 'failed',
      allowedFrom: ['running'],
      now: 300,
      reason: 'native-claim-without-original-host-work',
      executionContext: context,
    }
    const before = await snapshot(f)
    for (const purpose of purposes)
      expect(
        causes(
          await rejection(
            runWithTaskExecutionContext(context, () =>
              selectTaskRuntimeLifecycleWrites(f.persistence, purpose).trySet(mutation),
            ),
          ),
        ).some(
          (cause) => cause instanceof Error && cause.message === 'task-host-admitted-work-required',
        ),
      ).toBe(true)
    expect(await snapshot(f)).toEqual(before)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
    expect(f.transactions).toEqual([])
  })

  for (const to of ['failed', 'interrupted', 'canceled', 'awaiting_human'] as const) {
    test(`draining accepts the original ${to} result without new Task work`, async () => {
      const f = await claimedFixture(harness.db)
      await f.h.selected.context.drain(f.h.receipt)
      f.h.lose()
      expect(await write(f, 'issuedResults', input(f, to))).toBe(true)
      expect(await f.task()).toMatchObject({
        status: to,
        lifecycleEventRevision: 8,
        runningMs: 205,
      })
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
    })
  }

  test('draining refuses pending to running preparation without changing the original row or event', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'pending', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    const before = await snapshot(f)
    await f.h.selected.context.drain(f.h.receipt)
    expect(
      await rejection(
        write(f, 'preparation', { ...input(f, 'running'), allowedFrom: ['pending'] }),
      ),
    ).toBeDefined()
    expect(await snapshot(f)).toEqual(before)
    expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
  })

  test('the actual host wait precedes COMMIT and publication; the original publisher rejection keeps success', async () => {
    const f = await claimedFixture(harness.db)
    const before = await snapshot(f)
    const entered = deferred(),
      release = deferred()
    let published = 0,
      settled = false
    let publication:
      | {
          refs: readonly unknown[]
          activeFrames: boolean[]
          task: Awaited<ReturnType<typeof f.task>>
          events: Awaited<ReturnType<typeof f.events>>
        }
      | undefined
    let publisherErrorRaised = false
    let heldActive = false
    let heldTask: Awaited<ReturnType<typeof f.task>>
    f.controls.beforeConsume = async () => {
      const tx = f.transactions[0]!
      heldActive = databaseTransactionIsActive(tx)
      heldTask = await tx.select().from(tasks).where(eq(tasks.id, f.taskId)).get()
      entered.resolve()
      await release.promise
    }
    registerAfterCommitEventPump({
      async publishNow(refs) {
        published++
        publication = {
          refs: [...refs],
          activeFrames: f.transactions.map((tx) => databaseTransactionIsActive(tx)),
          task: await f.task(),
          events: await f.events(),
        }
        publisherErrorRaised = true
        throw new Error('original-publisher-rejection')
      },
      nudge() {},
    })
    const pending = write(f, 'issuedResults')
    const observed = pending.then(
      (value) => {
        settled = true
        return { value }
      },
      (error: unknown) => {
        settled = true
        return { error }
      },
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('lifecycle finished before host wait')
        }),
      ])
      expect(published).toBe(0)
      expect(f.transactions).toHaveLength(1)
      expect(heldActive).toBe(true)
      await nextTurn()
      expect(published).toBe(0)
      expect(settled).toBe(false)
      expect(heldTask).toMatchObject({ status: 'failed' })
      release.resolve()
      expect(await pending).toBe(true)
      expect(published).toBe(1)
      expect(publication?.refs).toHaveLength(1)
      expect(publication?.activeFrames).toEqual([false])
      expect(publication?.task).toMatchObject({ status: 'failed', lifecycleEventRevision: 8 })
      expect(publication?.events).toHaveLength(before.events.length + 1)
      expect(publisherErrorRaised).toBe(true)
      expect(await f.task()).toMatchObject({ status: 'failed' })
      expect(await f.events()).toHaveLength(before.events.length + 1)
    } finally {
      release.resolve()
      await observed
    }
  })

  test('preparation captures original input and work before the actual workspace await and another context', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'failed', runningSince: null, finishedAt: 200 })
      .where(eq(tasks.id, f.taskId))
    const entered = deferred(),
      release = deferred()
    f.controls.exists = async (reference) => {
      expect(reference).toBe(`/tmp/worktree/${f.taskId}`)
      expect(currentTaskExecutionContext()).toBe(f.context)
      entered.resolve()
      await release.promise
      expect(currentTaskExecutionContext()).toBe(f.context)
      return true
    }
    const mutation = {
      ...input(f, 'pending'),
      allowedFrom: ['failed' as TaskStatus],
      allowTerminal: true,
    }
    const pending = write(f, 'preparation', mutation)
    const observed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('revival finished before workspace await')
        }),
      ])
      const other = await additionalTaskHostFixture(f.h, `lifecycle-other-${ulid()}`)
      const otherClaim = await other.claim()
      other.module.claimGate.leave(otherClaim.permit)
      const otherWork = taskHostWorkForToken(otherClaim.token)
      if (otherWork === undefined) throw new Error('original-other-lifecycle-work-missing')
      const otherContext = createTaskExecutionContext({
        intentId: other.intentId,
        token: otherClaim.token,
        persistence: other.persistence,
        legacyConnection: other.db,
        compatibility: { db: other.db },
        hostWriteCapture: taskHostWorkCapture(otherWork),
      })
      const otherSnapshot = async () => ({
        task: await other.db.select().from(tasks).where(eq(tasks.id, other.taskId)).get(),
        owners: await other.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, other.taskId))
          .all(),
      })
      const otherBefore = await otherSnapshot()
      mutation.allowedFrom.splice(0, 1, 'running')
      Object.assign(mutation, {
        now: 900,
        to: 'canceled',
        extra: { finishedAt: 900, errorSummary: 'later input' },
      })
      runWithTaskExecutionContext(otherContext, () => release.resolve())
      expect(await pending).toBe(true)
      expect(await f.task()).toMatchObject({
        status: 'pending',
        finishedAt: 300,
        errorSummary: 'original result',
        errorMessage: 'original detail',
        failedNodeId: 'original-node',
        lifecycleEventRevision: 8,
      })
      expect((await f.owners())[0]).toMatchObject({ updatedAt: 300 })
      expect(f.calls).toEqual({ preparation: 1, issuedResults: 0 })
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
      expect(await otherSnapshot()).toEqual(otherBefore)
    } finally {
      release.resolve()
      await observed
    }
  })

  test('preparation captures its original context before the first actual Task read finishes', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'pending', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    const before = await snapshot(f)
    const native = f.persistence.runtimeLifecycle as DrizzleTaskRuntimeLifecyclePersistence
    const reader = native as unknown as { load(taskId: string): Promise<unknown> }
    const load = reader.load
    const entered = deferred(),
      release = deferred()
    const spy = spyOn(reader, 'load').mockImplementation(async function (
      this: unknown,
      taskId: string,
    ) {
      expect(this).toBe(native)
      expect(taskId).toBe(f.taskId)
      expect(currentTaskExecutionContext()).toBe(f.context)
      const row = await load.call(native, taskId)
      entered.resolve()
      await release.promise
      expect(currentTaskExecutionContext()).toBe(f.context)
      return row
    })
    spies.push(spy)
    const pending = write(f, 'preparation', { ...input(f, 'running'), allowedFrom: ['pending'] })
    const observed = pending.then(
      () => ({ failed: false }),
      (error: unknown) => ({ failed: true, error }),
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('preparation finished before original Task read')
        }),
      ])
      f.h.lose()
      release.resolve()
      expect((await observed).failed).toBe(true)
      expect(await snapshot(f)).toEqual(before)
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await observed
    }
  })

  test('loss during the real revival workspace await rolls back new preparation using the original capture', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'failed', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    const before = await snapshot(f)
    const entered = deferred(),
      release = deferred()
    f.controls.exists = async () => {
      entered.resolve()
      await release.promise
      return true
    }
    const pending = write(f, 'preparation', {
      ...input(f, 'pending'),
      allowedFrom: ['failed'],
      allowTerminal: true,
    })
    const observed = pending.then(
      () => ({ failed: false }),
      (error: unknown) => ({ failed: true, error }),
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('revival finished before workspace await')
        }),
      ])
      f.h.lose()
      release.resolve()
      expect((await observed).failed).toBe(true)
      expect(await snapshot(f)).toEqual(before)
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
    } finally {
      release.resolve()
      await observed
    }
  })

  test('a real missing-workspace tombstone and original owner increment commit together before the original 410', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'failed', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    f.controls.exists = async () => false
    const before = await snapshot(f)
    if (before.task === undefined) throw new Error('original-tombstone-task-missing')
    const mutation = {
      ...input(f, 'pending'),
      allowedFrom: ['failed' as TaskStatus],
      allowTerminal: true,
    }
    const error = new Error('tombstone-host-rejection')
    f.controls.reject = error
    expect(causes(await rejection(write(f, 'issuedResults', mutation)))).toContain(error)
    expect(await snapshot(f)).toEqual(before)
    delete f.controls.reject
    const pruned = await rejection(write(f, 'issuedResults', mutation))
    expect(pruned).toMatchObject({ code: 'workspace-pruned', status: 410 })
    expect(await f.task()).toEqual({ ...before.task, workspacePrunedAt: 300 })
    expect(await f.owners()).toEqual(
      before.owners.map((owner) => ({ ...owner, revision: owner.revision + 1, updatedAt: 300 })),
    )
    expect(await f.events()).toEqual(before.events)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 2 })
  })

  for (const selected of [true, false]) {
    test(`${selected ? 'selected' : 'native'} revival tombstone preserves the original zero-row result and its transaction boundary`, async () => {
      const f = await claimedFixture(harness.db)
      await harness.db
        .update(tasks)
        .set({ status: 'failed', runningSince: null })
        .where(eq(tasks.id, f.taskId))
      const before = await snapshot(f)
      if (before.task === undefined) throw new Error('original-revival-task-missing')
      f.controls.exists = async () => {
        await harness.db
          .update(tasks)
          .set({ worktreePath: 'workspace:next' })
          .where(eq(tasks.id, f.taskId))
        return false
      }
      const mutation = {
        ...input(f, 'pending'),
        allowedFrom: ['failed' as TaskStatus],
        allowTerminal: true,
      }
      const lifecycle = selected
        ? selectTaskRuntimeLifecycleWrites(f.persistence, 'issuedResults')
        : createTaskExecutionPersistence(harness.db, { workspacePresence: f.presence })
            .runtimeLifecycle
      expect(await runWithTaskExecutionContext(f.context, () => lifecycle.trySet(mutation))).toBe(
        false,
      )
      expect(await f.task()).toEqual({ ...before.task, worktreePath: 'workspace:next' })
      expect(await f.owners()).toEqual(
        selected
          ? before.owners
          : before.owners.map((owner) => ({
              ...owner,
              revision: owner.revision + 1,
              updatedAt: 300,
            })),
      )
      expect(await f.events()).toEqual(before.events)
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
    })
  }
})

const sourceFiles = new Map<string, ts.SourceFile>()
function source(path: string): ts.SourceFile {
  let file = sourceFiles.get(path)
  if (file === undefined) {
    const text = readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')
    file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    sourceFiles.set(path, file)
  }
  return file
}
function visit(file: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = []
  const walk = (node: ts.Node) => {
    if (predicate(node)) nodes.push(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  return nodes
}
function lifecycleCalls(file: ts.SourceFile): ts.CallExpression[] {
  return visit(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
    if (!['trySet', 'trySetWithGuard'].includes(node.expression.name.text)) return false
    const receiver = node.expression.expression
    return (
      receiver.getText(file).includes('.runtimeLifecycle') ||
      receiver.getText(file) === 'taskLifecycle' ||
      (ts.isCallExpression(receiver) &&
        receiver.expression.getText(file) === 'selectTaskRuntimeLifecycleWrites')
    )
  }) as ts.CallExpression[]
}
function printed(node: ts.Node, file: ts.SourceFile): string {
  return ts
    .createPrinter({ newLine: ts.NewLineKind.LineFeed })
    .printNode(ts.EmitHint.Unspecified, node, file)
}
function actualReporter(path: string, index: number): string {
  const file = source(path)
  const reporters = visit(
    file,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'failureReporter' &&
      ts.isObjectLiteralExpression(node.initializer),
  ) as ts.PropertyAssignment[]
  const reporter = reporters[index]
  if (reporter === undefined) throw new Error('original-lifecycle-reporter-missing')
  return reporter.initializer.getText(file)
}
/** Evaluate only the finite original method bodies; service bootstraps are not loaded. */
function evaluate<T>(body: string, environment: Readonly<Record<string, unknown>>): T {
  const result = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  return new Function(...Object.keys(environment), result.outputText)(
    ...Object.values(environment),
  ) as T
}
const taskModule = 'packages/backend/src/modules/task-execution/'
const enginePath = taskModule + 'composition/taskEngineApplication.ts'
const reporters = [
  {
    id: 'L06',
    path: 'packages/backend/src/cli/postgresqlDaemonApplication.ts',
    index: 0,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L07',
    path: 'packages/backend/src/cli/start.ts',
    index: 0,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L08',
    path: 'packages/backend/src/cli/start.ts',
    index: 1,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L09',
    path: 'packages/backend/src/server.ts',
    index: 0,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L10',
    path: 'packages/backend/src/server.ts',
    index: 1,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L11',
    path: 'packages/backend/src/server.ts',
    index: 2,
    summary: 'task drive failed',
    failure: 'task-drive-failed',
  },
  {
    id: 'L12',
    path: taskModule + 'infrastructure/childTaskLifecycleParticipant.ts',
    index: 0,
    summary: 'task resume failed',
    failure: 'task-resume-failed',
  },
  {
    id: 'L14',
    path: taskModule + 'infrastructure/postgresqlFusionEngineTaskOperations.ts',
    index: 0,
    summary: 'fusion engine task failed',
    failure: 'fusion-engine-launch-failed',
  },
  {
    id: 'L15',
    path: taskModule + 'infrastructure/childExecutionLaunchOperations.ts',
    index: 0,
    summary: 'child task launch failed',
    failure: 'child-task-launch-failed',
  },
] as const
const CLOCK = 1000
function reporter(f: Fixture, record: (typeof reporters)[number]): TaskDriveFailureReporter {
  return evaluate<TaskDriveFailureReporter>(
    'return (' + actualReporter(record.path, record.index) + ')',
    {
      taskExecutionProvider: { persistence: f.persistence },
      taskExecutionPersistence: f.persistence,
      persistence: f.persistence,
      dependencies: { persistence: f.persistence, now: () => CLOCK },
      selectTaskRuntimeLifecycleWrites,
      Date: { now: () => CLOCK },
    },
  )
}

type EngineBinding = {
  readonly taskId: string
  readonly persistence: TaskExecutionPersistence
  readonly executionContext: TaskExecutionContextRef
}
type EngineMethods = {
  failRuntimeTask(
    opts: EngineBinding,
    summary: string,
    detail: string,
    node?: string,
  ): Promise<void>
  cancelRuntimeTask(opts: EngineBinding, node?: string, reason?: unknown): Promise<void>
}
function engineMethods(): EngineMethods {
  const file = source(enginePath)
  const names = ['taskStopCauseFromUnknown', 'failRuntimeTask', 'cancelRuntimeTask']
  const declarations = visit(
    file,
    (node) =>
      ts.isFunctionDeclaration(node) && node.name !== undefined && names.includes(node.name.text),
  )
  if (declarations.length !== names.length)
    throw new Error('original-engine-lifecycle-functions-missing')
  return evaluate<EngineMethods>(
    declarations.map((node) => node.getText(file)).join('\n') +
      '\nreturn { failRuntimeTask, cancelRuntimeTask }',
    {
      selectTaskRuntimeLifecycleWrites,
      isDaemonInterruptionAbortReason,
      taskStopProjection,
      withTaskReviewMutationLock,
      createLogger,
      DAEMON_RESTART_ERROR_SUMMARY,
      Date: { now: () => CLOCK },
    },
  )
}
function engineStateCall(
  f: ClaimedFixture,
  reason: 'runTask-start' | 'scope-awaiting-human',
): Promise<boolean> {
  const file = source(enginePath)
  const calls = lifecycleCalls(file).filter((node) =>
    node.arguments[0]?.getText(file).includes("reason: '" + reason + "'"),
  )
  if (calls.length !== 1) throw new Error('original-engine-state-call-missing')
  return evaluate<Promise<boolean>>('return (' + calls[0]!.getText(file) + ')', {
    selectTaskRuntimeLifecycleWrites,
    opts: { taskId: f.taskId, persistence: f.persistence, executionContext: f.context },
    taskId: f.taskId,
    Date: { now: () => CLOCK },
  })
}

describeEachProvider('RFC-370 original Task lifecycle callers retain their work', (harness) => {
  for (const record of reporters) {
    test(`${record.id}: its actual reporter records draining failure through the real attached coordinator`, async () => {
      const f = await fixture(harness.db)
      const error = new Error('original-drive-result')
      const original = reporter(f, record)
      let reports = 0
      let reportWrites = 0
      const coordinator = new DefaultTaskDriveCoordinator({
        runtime: resolveTaskDriveConfig({ appHome: '/tmp/rfc370-lifecycle' }),
        lifecycle: f.lifecycle,
        repositoryPreparation: skipRepositoryPreparation,
        engineOrchestrator: {
          async drive(context) {
            expect(context.taskId).toBe(f.taskId)
            expect(taskHostWorkForToken(context.execution.token)).toBeDefined()
            await f.h.selected.context.drain(f.h.receipt)
            throw error
          },
        },
        failureReporter: {
          async report(input) {
            reports++
            const before = f.calls.issuedResults
            await original.report.call(original, input)
            reportWrites = f.calls.issuedResults - before
          },
        },
      })
      expect(
        causes(
          await rejection(
            coordinator.submit({
              taskId: f.taskId,
              intentId: f.h.intentId,
              completionMode: 'await-settle',
            }),
          ),
        ),
      ).toContain(error)
      expect(reports).toBe(1)
      expect(reportWrites).toBe(1)
      expect(await f.task()).toMatchObject({
        status: 'failed',
        finishedAt: CLOCK,
        errorSummary: record.summary,
        errorMessage: error.message,
      })
      expect(
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, f.h.intentId))
          .get(),
      ).toMatchObject({ state: 'failed', failureCode: record.failure })
      expect(await f.events()).toHaveLength(1)
    }, 30_000)

    test(`${record.id}: the real not-attached coordinator never calls its reporter or writes another lifecycle result`, async () => {
      const f = await fixture(harness.db)
      const controller = new AbortController()
      const attached = await f.lifecycle.attach({
        taskId: f.taskId,
        intentId: f.h.intentId,
        controller,
      })
      expect(attached.kind).toBe('attached')
      // A live attachable driver is awaited, not refused. Park the original task
      // so the real attachable-status check supplies the not-attached outcome.
      await harness.db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, f.taskId))
      const before = await snapshot(f)
      const original = reporter(f, record)
      let reports = 0,
        drives = 0
      const coordinator = new DefaultTaskDriveCoordinator({
        runtime: resolveTaskDriveConfig({ appHome: '/tmp/rfc370-lifecycle' }),
        lifecycle: f.lifecycle,
        repositoryPreparation: skipRepositoryPreparation,
        engineOrchestrator: {
          async drive() {
            drives++
          },
        },
        failureReporter: {
          async report(input) {
            reports++
            return await original.report.call(original, input)
          },
        },
      })
      try {
        expect(
          await coordinator.submit({
            taskId: f.taskId,
            intentId: f.h.intentId,
            completionMode: 'await-settle',
          }),
        ).toMatchObject({ kind: 'not-attached' })
        expect(reports).toBe(0)
        expect(drives).toBe(0)
        expect(f.calls.issuedResults).toBe(0)
        expect(await snapshot(f)).toEqual(before)
      } finally {
        await f.lifecycle.releaseAndFinalize({ taskId: f.taskId, controller })
      }
    }, 30_000)
  }

  test('L01 original running preparation commits before the engine can continue, and draining refusal returns no new state', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'pending', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    expect(
      await runWithTaskExecutionContext(f.context, () => engineStateCall(f, 'runTask-start')),
    ).toBe(true)
    expect(await f.task()).toMatchObject({ status: 'running', runningSince: CLOCK })
    expect(f.calls).toEqual({ preparation: 1, issuedResults: 0 })
    await harness.db
      .update(tasks)
      .set({ status: 'pending', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    const before = await snapshot(f)
    await f.h.selected.context.drain(f.h.receipt)
    expect(
      await rejection(
        runWithTaskExecutionContext(f.context, () => engineStateCall(f, 'runTask-start')),
      ),
    ).toBeDefined()
    expect(await snapshot(f)).toEqual(before)
  })

  test('L02 original engine failure uses its exact Task context and preserves the returned failure details while draining', async () => {
    const f = await claimedFixture(harness.db)
    await f.h.selected.context.drain(f.h.receipt)
    await runWithTaskExecutionContext(f.context, () =>
      engineMethods().failRuntimeTask(
        { taskId: f.taskId, persistence: f.persistence, executionContext: f.context },
        'original-preflight-failure',
        'original resources unavailable',
        'original-node',
      ),
    )
    expect(await f.task()).toMatchObject({
      status: 'failed',
      errorSummary: 'original-preflight-failure',
      errorMessage: 'original resources unavailable',
      failedNodeId: 'original-node',
      finishedAt: CLOCK,
    })
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })

  for (const reason of [
    {
      name: 'shutdown',
      value: DAEMON_SHUTDOWN_ABORT_REASON,
      status: 'interrupted',
    },
    { name: 'user', value: { kind: 'user' }, status: 'canceled' },
    {
      name: 'parent',
      value: { kind: 'parent-cascade', parentTaskId: 'original-parent' },
      status: 'canceled',
    },
    {
      name: 'webhook',
      value: {
        kind: 'webhook-terminal',
        terminal: 'closed',
        deliveryId: 'original-delivery',
        streamRevision: 7,
      },
      status: 'canceled',
    },
  ] as const) {
    test(`L03/L04 actual ${reason.name} stop keeps its original projection and acknowledges only the existing work`, async () => {
      const f = await claimedFixture(harness.db)
      await f.h.selected.context.drain(f.h.receipt)
      await runWithTaskExecutionContext(f.context, () =>
        engineMethods().cancelRuntimeTask(
          { taskId: f.taskId, persistence: f.persistence, executionContext: f.context },
          'original-node',
          reason.value,
        ),
      )
      const expectedSummary =
        reason.name === 'shutdown'
          ? DAEMON_RESTART_ERROR_SUMMARY
          : taskStopProjection(reason.value).summary
      expect(await f.task()).toMatchObject({
        status: reason.status,
        errorSummary: expectedSummary,
        failedNodeId: 'original-node',
        finishedAt: CLOCK,
      })
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
    })
  }

  test('L05 actual scope awaiting-human result keeps the original lifecycle and no new dispatch admission', async () => {
    const f = await claimedFixture(harness.db)
    await f.h.selected.context.drain(f.h.receipt)
    expect(
      await runWithTaskExecutionContext(f.context, () =>
        engineStateCall(f, 'scope-awaiting-human'),
      ),
    ).toBe(true)
    expect(await f.task()).toMatchObject({
      status: 'awaiting_human',
      runningMs: 905,
      runningSince: null,
      lifecycleEventRevision: 8,
    })
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })

  test('L13 actual unsafe-resume helper keeps failed state, recovery record and original ConflictError order', async () => {
    const f = await claimedFixture(harness.db)
    await harness.db
      .update(tasks)
      .set({ status: 'pending', runningSince: null })
      .where(eq(tasks.id, f.taskId))
    await f.h.selected.context.drain(f.h.receipt)
    const file = source(taskModule + 'infrastructure/childTaskLifecycleParticipant.ts')
    const declarations = visit(
      file,
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'markUnsafeResume',
    )
    expect(declarations).toHaveLength(1)
    const helper = evaluate<
      (
        dependencies: { persistence: TaskExecutionPersistence },
        input: {
          taskId: string
          nodeRunId: string
          nodeId: string
          executionContext: TaskExecutionContextRef
          code: 'snapshot-lost'
          detail: string
        },
      ) => Promise<never>
    >(declarations[0]!.getText(file) + '\nreturn markUnsafeResume', {
      selectTaskRuntimeLifecycleWrites,
      ulid,
      ConflictError,
      Date: { now: () => CLOCK },
    })
    const error = await rejection(
      runWithTaskExecutionContext(f.context, () =>
        helper(
          { persistence: f.persistence },
          {
            taskId: f.taskId,
            nodeRunId: 'original-unsafe-run',
            nodeId: 'original-unsafe-node',
            executionContext: f.context,
            code: 'snapshot-lost',
            detail: 'original missing snapshot',
          },
        ),
      ),
    )
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'snapshot-lost' })
    expect(await f.task()).toMatchObject({
      status: 'failed',
      errorSummary: 'snapshot-lost',
      errorMessage: 'original missing snapshot',
      failedNodeId: 'original-unsafe-node',
    })
    expect(
      await harness.db
        .select()
        .from(recoveryEvents)
        .where(eq(recoveryEvents.taskId, f.taskId))
        .all(),
    ).toMatchObject([
      {
        kind: 'snapshot-lost',
        createdAt: CLOCK,
        beforeJson: '{"status":"pending"}',
        afterJson: '{"status":"failed"}',
      },
    ])
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })
})

test('all 21 original calls retain their exact inputs; removing the 15 selections recovers every whole original caller', async () => {
  let selected = 0,
    native = 0
  const config = JSON.parse(
    readFileSync(new URL('../../../.prettierrc', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  for (const original of originalCallers.wholeCallers) {
    const file = source(original.path)
    const expected = originalCallers.calls.filter((call) => call.path === original.path)
    const calls = lifecycleCalls(file)
    expect(calls).toHaveLength(expected.length)
    const edits: { start: number; end: number; text: string }[] = []
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!,
        old = expected[i]!
      const prior = ts.createSourceFile(
        'original-call.ts',
        old.call,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const oldCalls = visit(prior, ts.isCallExpression) as ts.CallExpression[]
      const originalCall = oldCalls[0]!
      expect(call.arguments.map((arg) => printed(arg, file))).toEqual(
        originalCall.arguments.map((arg) => printed(arg, prior)),
      )
      const callee = call.expression as ts.PropertyAccessExpression
      const receiver = callee.expression
      if (old.purpose === null) {
        native++
        expect(callee.getText(file)).toBe(old.callee)
      } else {
        selected++
        expect(ts.isCallExpression(receiver)).toBe(true)
        if (!ts.isCallExpression(receiver)) throw new Error('selected-lifecycle-call-missing')
        expect(receiver.expression.getText(file)).toBe('selectTaskRuntimeLifecycleWrites')
        expect(receiver.arguments).toHaveLength(2)
        expect(receiver.arguments[0]!.getText(file) + '.runtimeLifecycle.' + callee.name.text).toBe(
          old.callee,
        )
        expect(ts.isStringLiteral(receiver.arguments[1]!)).toBe(true)
        expect((receiver.arguments[1] as ts.StringLiteral).text).toBe(old.purpose)
        edits.push({ start: callee.getStart(file), end: callee.end, text: old.callee })
      }
    }
    if (original.path.includes('/cli/') || original.path.endsWith('/server.ts')) {
      const restored = inverseTaskRuntimeLifecycleRootSelections(file)
      let expectedText = file.text
      for (const edit of [...edits].sort((a, b) => b.start - a.start))
        expectedText = expectedText.slice(0, edit.start) + edit.text + expectedText.slice(edit.end)
      expect(restored.text).toBe(expectedText)
      for (const statement of restored.statements) expect(statement.parent).toBe(restored)
      const first = calls[0]!
      const selection = (first.expression as ts.PropertyAccessExpression)
        .expression as ts.CallExpression
      const wrongPurpose = selection.arguments[1]!
      const changed = (start: number, end: number, replacement: string) =>
        ts.createSourceFile(
          file.fileName,
          file.text.slice(0, start) + replacement + file.text.slice(end),
          ts.ScriptTarget.Latest,
          true,
        )
      expect(() =>
        inverseTaskRuntimeLifecycleRootSelections(
          changed(wrongPurpose.getStart(file), wrongPurpose.end, "'preparation'"),
        ),
      ).toThrow('task-lifecycle inverse unreviewed call: ' + expected[0]!.id)
      expect(() =>
        inverseTaskRuntimeLifecycleRootSelections(
          changed(first.arguments[0]!.getStart(file), first.arguments[0]!.end, '{}'),
        ),
      ).toThrow('task-lifecycle inverse unreviewed call: ' + expected[0]!.id)
      expect(() =>
        inverseTaskRuntimeLifecycleRootSelections(changed(first.getStart(file), first.end, 'true')),
      ).toThrow('task-lifecycle inverse selected call population changed')
    }
    const imports = visit(
      file,
      (node) =>
        ts.isImportDeclaration(node) &&
        node.getText(file).includes('selectTaskRuntimeLifecycleWrites'),
    )
    if (expected.some((call) => call.purpose !== null)) expect(imports).toHaveLength(1)
    for (const node of imports)
      edits.push({
        start: node.getStart(file),
        end: node.end + (file.text[node.end] === '\n' ? 1 : 0),
        text: '',
      })
    if (original.path === taskModule + 'composition/taskExecutionPersistence.ts') {
      const additions = visit(
        file,
        (node) =>
          ts.isPropertyAssignment(node) &&
          ['runtimeLifecycleWriteMode', 'runtimeLifecycleWritePurposes'].includes(
            node.name.getText(file),
          ),
      )
      expect(additions).toHaveLength(2)
      for (const node of additions) {
        const start = file.text.lastIndexOf('\n', node.getStart(file) - 1) + 1
        let end = node.end + (file.text[node.end] === ',' ? 1 : 0)
        expect(file.text.slice(start, node.getStart(file))).toMatch(/^\s*$/)
        if (file.text[end] === '\n') end++
        edits.push({ start, end, text: '' })
      }
      const constructors = visit(
        file,
        (node) =>
          ts.isImportDeclaration(node) &&
          node.getText(file).includes('createSelectedTaskRuntimeLifecycleWritePurposes'),
      )
      expect(constructors).toHaveLength(1)
      for (const node of constructors)
        edits.push({
          start: node.getStart(file),
          end: node.end + (file.text[node.end] === '\n' ? 1 : 0),
          text: '',
        })
    }
    let inverse = file.text
    for (const edit of edits.sort((a, b) => b.start - a.start))
      inverse = inverse.slice(0, edit.start) + edit.text + inverse.slice(edit.end)
    inverse = await format(inverse, { ...config, parser: 'typescript' })
    expect(Buffer.byteLength(inverse)).toBe(original.bytes)
    expect(createHash('sha256').update(inverse).digest('hex')).toBe(original.sha256)
  }
  expect(selected).toBe(15)
  expect(native).toBe(6)
  expect(originalCallers.calls.map((call) => call.id).sort()).toEqual(
    Array.from({ length: 21 }, (_, i) => 'L' + String(i + 1).padStart(2, '0')),
  )
}, 30_000)
