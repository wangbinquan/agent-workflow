// RFC-370 C2-W1 D4/D5: a rejected claim promise is not an absent durable claim.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners, tasks } from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { DrizzleTaskOwnershipPersistence } from '@/modules/task-execution/infrastructure/taskOwnershipPersistence'
import { taskHostClaimFailureFactQueries } from '@/modules/task-execution/infrastructure/taskHostClaimFailure'
import { clearTaskDriverLifecycleForTesting } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { taskHostWorkForToken } from '@/modules/task-execution/application/taskHostAdmission'
import { describeEachProvider } from './helpers/eachProvider'
import { deferred, nextTurn, taskHostFixture } from './helpers/taskHostExecution'
import {
  scheduledTaskRuntime,
  taskExecutionResourceBinding,
} from './helpers/integrationTriggerResourceBinding'

afterEach(() => clearTaskDriverLifecycleForTesting())

function ownerWrites(sql: string): boolean {
  return /\bupdate\b.*\btask_execution_owners\b/i.test(sql)
}

async function releasedOwner(db: ProviderNeutralDatabase, taskId: string) {
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: 'previous-owner',
    daemonGeneration: 'previous-generation',
    epoch: 4,
    revision: 8,
    state: 'released',
    leaseUntil: 1,
    lastHeartbeatAt: 1,
    recoveryCode: null,
    recoveryProofDigest: 'previous-proof',
    updatedAt: 1,
  })
  return (
    await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
  )[0]!
}

describeEachProvider('RFC-370 original failed claim acknowledgement', (harness) => {
  for (const mode of ['direct', 'provider'] as const) {
    test(`${mode}: committed claim response loss retains the original capture until precise recovery ACK`, async () => {
      const h = await taskHostFixture(harness.db, `failed-claim-${mode}`, { mode })
      const originalClaim = DrizzleTaskOwnershipPersistence.prototype.claimPendingIntent
      const originalMark = DrizzleTaskOwnershipPersistence.prototype.markRecoveryRequired
      const claimError = new Error('original claim result lost')
      const ackError = new Error('first recovery ACK rejected')
      const captured: {
        receiver?: DrizzleTaskOwnershipPersistence
        work?: ReturnType<typeof taskHostWorkForToken>
      } = {}
      let marks = 0
      const claim = spyOn(
        DrizzleTaskOwnershipPersistence.prototype,
        'claimPendingIntent',
      ).mockImplementation(async function (this: DrizzleTaskOwnershipPersistence, input) {
        captured.receiver = this
        const token = await originalClaim.call(this, input)
        captured.work = taskHostWorkForToken(token)
        h.lose()
        throw claimError
      })
      const mark = spyOn(
        DrizzleTaskOwnershipPersistence.prototype,
        'markRecoveryRequired',
      ).mockImplementation(async function (this: DrizzleTaskOwnershipPersistence, input) {
        expect(this).toBe(captured.receiver)
        expect(taskHostWorkForToken(input.token)).toBe(captured.work)
        marks++
        if (marks === 1) throw ackError
        return originalMark.call(this, input)
      })
      try {
        await expect(h.claim()).rejects.toBe(claimError)
        await h.module.awaitIdle()
        expect(h.completed).toBe(0)
        expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
        expect(h.module.host!.finalizations.snapshot()).toEqual([
          { taskId: h.taskId, phase: 'pending', error: ackError },
        ])
        expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('claimed')
        expect(
          (
            await h.db
              .select()
              .from(taskExecutionIntents)
              .where(eq(taskExecutionIntents.id, h.intentId))
          )[0]?.state,
        ).toBe('claimed')
        DrizzleTaskOwnershipPersistence.prototype.markRecoveryRequired = async () => {
          throw new Error('replacement must not receive the old ACK')
        }
        h.leases[0]!.complete = () => {
          throw new Error('replacement completion must not run')
        }
        await h.module.host!.finalizations.retryPending()
        const [owner] = await h.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId))
        expect(owner?.state).toBe('recovery-required')
        expect(owner?.recoveryCode).toBe('task-host-claim-result-unknown')
        expect(owner?.recoveryProofDigest).toBeNull()
        expect(owner?.epoch).toBe(1)
        expect(marks).toBe(2)
        expect(h.completed).toBe(1)
        expect(h.module.host!.finalizations.snapshot()).toEqual([])
        expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
          'running',
        )
      } finally {
        mark.mockRestore()
        claim.mockRestore()
      }
    }, 15_000)

    test(`${mode}: committed recovery response loss confirms the original tuple/time without repeating its SQL`, async () => {
      const h = await taskHostFixture(harness.db, `failed-mark-${mode}`, { mode })
      const originalClaim = DrizzleTaskOwnershipPersistence.prototype.claimPendingIntent
      const originalMark = DrizzleTaskOwnershipPersistence.prototype.markRecoveryRequired
      const claimError = new Error('claim response unknown')
      const markError = new Error('recovery response unknown')
      let marks = 0
      const claim = spyOn(
        DrizzleTaskOwnershipPersistence.prototype,
        'claimPendingIntent',
      ).mockImplementation(async function (this: DrizzleTaskOwnershipPersistence, input) {
        await originalClaim.call(this, input)
        throw claimError
      })
      const mark = spyOn(
        DrizzleTaskOwnershipPersistence.prototype,
        'markRecoveryRequired',
      ).mockImplementation(async function (this: DrizzleTaskOwnershipPersistence, input) {
        marks++
        await originalMark.call(this, input)
        throw markError
      })
      try {
        await expect(h.claim()).rejects.toBe(claimError)
        expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('recovery-required')
        expect(h.completed).toBe(0)
        const recording = harness.recordStatements()
        try {
          await h.module.host!.finalizations.retryPending()
          expect(recording.statements.filter(({ sql }) => ownerWrites(sql))).toEqual([])
          expect(marks).toBe(1)
          expect(h.completed).toBe(1)
          expect(h.module.host!.finalizations.snapshot()).toEqual([])
        } finally {
          recording.stop()
        }
      } finally {
        mark.mockRestore()
        claim.mockRestore()
      }
    }, 15_000)
  }

  test('another persisted tuple stays pending and resource editing remains available', async () => {
    const h = await taskHostFixture(harness.db, 'failed-claim-other-owner')
    const original = h.persistence.ownership.claimPendingIntent
    const error = new Error('claim result missing')
    h.persistence.ownership.claimPendingIntent = async function (input) {
      await original.call(this, input)
      await h.db
        .update(taskExecutionOwners)
        .set({ epoch: 2, revision: 2 })
        .where(eq(taskExecutionOwners.taskId, h.taskId))
      throw error
    }
    await expect(h.claim()).rejects.toBe(error)
    expect(h.completed).toBe(0)
    const originalBarrier = h.module.host!.finalizations.pendingForTask(h.taskId)
    expect(originalBarrier).toBeDefined()
    await expect(h.module.host!.finalizations.retryPending()).rejects.toMatchObject({
      code: 'task-execution-stale-owner',
    })
    expect(h.module.host!.finalizations.pendingForTask(h.taskId)).toBe(originalBarrier)
    expect(h.completed).toBe(0)
    await h.db
      .update(tasks)
      .set({ name: 'editable with original ACK pending' })
      .where(eq(tasks.id, h.taskId))
    expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.name).toBe(
      'editable with original ACK pending',
    )
  }, 15_000)

  test('an original ACK query rejection keeps its method/receiver and drain retries the same failed call', async () => {
    const h = await taskHostFixture(harness.db, 'failed-claim-query')
    const facts = taskHostClaimFailureFactQueries(h.persistence.ownership)!
    const originalRead = facts.read,
      originalClaim = h.persistence.ownership.claimPendingIntent
    const claimError = new Error('claim return lost'),
      queryError = new Error('original facts query failed')
    let reads = 0
    facts.read = async function (...args) {
      expect(this).toBe(facts)
      reads++
      if (reads === 1) throw queryError
      return originalRead.apply(this, args)
    }
    h.persistence.ownership.claimPendingIntent = async function (input) {
      await originalClaim.call(this, input)
      throw claimError
    }
    await expect(h.claim()).rejects.toBe(claimError)
    expect(h.completed).toBe(0)
    expect(h.module.host!.finalizations.snapshot()).toEqual([
      { taskId: h.taskId, phase: 'pending', error: queryError },
    ])
    facts.read = async () => {
      throw new Error('replacement query must not consume old work')
    }
    await h.module.host!.finalizations.drain()
    expect(reads).toBe(2)
    expect(h.completed).toBe(1)
    expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('recovery-required')
  }, 15_000)

  test('a claim that never completed its SQL body acknowledges only the original business failure', async () => {
    const h = await taskHostFixture(harness.db, 'failed-claim-before-body')
    await expect(h.claim('missing-original-intent')).rejects.toMatchObject({
      code: 'task-execution-owner-conflict',
    })
    expect(h.completed).toBe(1)
    expect(h.module.host!.finalizations.snapshot()).toEqual([])
    expect(await h.db.select().from(taskExecutionOwners)).toEqual([])
    expect(
      (
        await h.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, h.intentId))
      )[0]?.state,
    ).toBe('pending')
  }, 15_000)

  test('a fulfilled original body rolled back by receipt rejection restores the complete previous released owner', async () => {
    const error = new Error('original new-work receipt rejected')
    const h = await taskHostFixture(harness.db, 'claim-full-before-owner', {
      beforeNewWork: () => {
        throw error
      },
    })
    const before = await releasedOwner(h.db, h.taskId)
    await expect(h.claim()).rejects.toBe(error)
    expect(
      (
        await h.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId))
      )[0],
    ).toEqual(before)
    expect(
      (
        await h.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, h.intentId))
      )[0]?.state,
    ).toBe('pending')
    expect(h.completed).toBe(1)
    expect(h.module.host!.finalizations.snapshot()).toEqual([])
    expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
  }, 15_000)

  test('jointly changed claim timestamps cannot confirm the original returned tuple', async () => {
    const h = await taskHostFixture(harness.db, 'claim-time-mismatch')
    const ownership = h.persistence.ownership,
      original = ownership.claimPendingIntent
    const error = new Error('original claim response lost')
    ownership.claimPendingIntent = async function (input) {
      await original.call(this, input)
      await h.db
        .update(taskExecutionOwners)
        .set({ lastHeartbeatAt: input.now + 1, updatedAt: input.now + 1 })
        .where(eq(taskExecutionOwners.taskId, h.taskId))
      await h.db
        .update(taskExecutionIntents)
        .set({ claimedAt: input.now + 1, updatedAt: input.now + 1 })
        .where(eq(taskExecutionIntents.id, h.intentId))
      throw error
    }
    await expect(h.claim()).rejects.toBe(error)
    expect(h.completed).toBe(0)
    expect((await ownership.read(h.taskId))?.state).toBe('claimed')
    expect(h.module.host!.finalizations.snapshot()[0]?.phase).toBe('pending')
    await expect(h.module.host!.finalizations.retryPending()).rejects.toMatchObject({
      code: 'task-execution-stale-owner',
    })
    expect(h.completed).toBe(0)
    expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
  }, 15_000)

  test('an unknown-scope failed call blocks selected attach outside the task lock until its exact old ACK', async () => {
    const h = await taskHostFixture(harness.db, 'unknown-failed-claim-scope')
    const facts = taskHostClaimFailureFactQueries(h.persistence.ownership)!
    const read = facts.read,
      originalError = new Error('failure before claim SQL')
    const queryError = new Error('first scope read failed')
    let reads = 0
    facts.read = async function (...args) {
      if (++reads === 1) throw queryError
      return read.call(this, ...args)
    }
    const claim = spyOn(h.persistence.ownership, 'claimPendingIntent').mockRejectedValue(
      originalError,
    )
    try {
      await expect(h.claim()).rejects.toBe(originalError)
    } finally {
      claim.mockRestore()
    }
    const barrier = h.module.host!.finalizations.pendingForTask(h.taskId)!
    expect(h.module.host!.finalizations.pendingForTask('another-task')).toBe(barrier)
    expect(h.module.host!.finalizations.snapshot()).toEqual([
      { taskId: undefined, phase: 'pending', error: queryError },
    ])
    const controller = new AbortController()
    let attached = false
    const attaching = h.lifecycle
      .attach({ taskId: h.taskId, intentId: h.intentId, controller })
      .then((result) => {
        attached = true
        return result
      })
    try {
      await nextTurn()
      expect(attached).toBe(false)
      expect(h.leases).toHaveLength(1)
      expect(h.completed).toBe(0)
      await h.db
        .update(tasks)
        .set({ name: 'editable while scope is unknown' })
        .where(eq(tasks.id, h.taskId))
      await h.module.host!.finalizations.retryPending()
      await barrier
      expect((await attaching).kind).toBe('attached')
      expect(h.leases).toHaveLength(2)
      expect(h.completed).toBe(1)
    } finally {
      await h.module.host!.finalizations.retryPending()
      const result = await attaching
      if (result.kind === 'attached')
        await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller })
    }
    expect(h.completed).toBe(2)
  }, 15_000)

  test('the actual background ACK loop retries failed claims after loss and drain waits for the old recovery ACK', async () => {
    const h = await taskHostFixture(harness.db, 'background-failed-claim')
    const ownership = h.persistence.ownership
    const claim = ownership.claimPendingIntent,
      mark = ownership.markRecoveryRequired
    const originalError = new Error('claim response lost'),
      ackError = new Error('recovery ACK failed')
    const retryEntered = deferred(),
      allowAck = deferred()
    let marks = 0
    ownership.claimPendingIntent = async function (input) {
      await claim.call(this, input)
      throw originalError
    }
    ownership.markRecoveryRequired = async function (input) {
      if (++marks === 1) throw ackError
      retryEntered.resolve()
      await allowAck.promise
      return mark.call(this, input)
    }
    await expect(h.claim()).rejects.toBe(originalError)
    const scheduled = scheduledTaskRuntime(h.db),
      identity = composeIdentityAccess(h.db)
    const control = composeTaskExecutionProviderBackground({
      module: h.module,
      recovery: h.persistence.recoveryAdministration,
      taskHasDriver: (id) => h.module.runtimeRegistry.hasTask(id),
      buildScheduleLaunch: () => async () => {
        throw new Error('new work must not dispatch')
      },
      autoResume: { run: async () => ({ resumed: [], skipped: [] }) },
      lifecycleRepair: { run: async () => ({ repaired: [], skipped: [] }) },
    })
    const timeout = spyOn(globalThis, 'setTimeout')
    let handle: Awaited<ReturnType<typeof control.startAuthority>> | undefined
    try {
      handle = await control.startAuthority(
        {
          configuration: {
            read: async () => ({
              ...DEFAULT_CONFIG,
              autoResumeOnBoot: false,
              autoRepair: {},
              autoKillStalledChild: false,
              periodicOrphanReconcileMs: 0,
            }),
          },
          scheduled: {
            operations: scheduled.operations,
            identityAccess: {
              delegatedRequests: identity.delegatedRequests,
              integrationTriggerResources: scheduled.integrationTriggerResources,
              taskExecutionResources: taskExecutionResourceBinding(h.db),
            },
          },
        },
        { current: () => h.grant.current() },
      )
      h.lose()
      await h.selected.context.drain(h.receipt)
      await handle.quiesceAuthorityLoss()
      const index = timeout.mock.calls.findIndex((args) => args[1] === 1_000)
      const args = timeout.mock.calls[index]!,
        timer = timeout.mock.results[index]!
      if (timer.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('actual failed-claim ACK timer missing')
      clearTimeout(timer.value)
      Reflect.apply(args[0], undefined, args.slice(2))
      await retryEntered.promise
      let drained = false
      const draining = handle.drain().then(() => {
        drained = true
      })
      await nextTurn()
      expect(h.completed).toBe(0)
      expect(drained).toBe(false)
      await h.db
        .update(tasks)
        .set({ name: 'editable while failed-claim ACK is pending' })
        .where(eq(tasks.id, h.taskId))
      allowAck.resolve()
      await draining
      expect(marks).toBe(2)
      expect(h.completed).toBe(1)
      expect(h.module.host!.finalizations.snapshot()).toEqual([])
      expect((await ownership.read(h.taskId))?.state).toBe('recovery-required')
      expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
    } finally {
      allowAck.resolve()
      if (handle !== undefined) {
        await handle.quiesceAuthorityLoss()
        await handle.drain()
      }
      timeout.mockRestore()
    }
  }, 15_000)

  for (const outcome of ['commit', 'rollback'] as const) {
    test(`${outcome}: unconfirmed COMMIT cannot turn an old negative read into an ACK before the actual row writer ends`, async () => {
      if (harness.capabilities.isolation === 'exclusive') {
        if (outcome === 'rollback') {
          const error = new Error('synchronous real claim rollback')
          const h = await taskHostFixture(harness.db, 'sync-claim-rollback', {
            beforeNewWork: () => {
              throw error
            },
          })
          const before = await releasedOwner(h.db, h.taskId)
          await expect(h.claim()).rejects.toBe(error)
          expect(
            (
              await h.db
                .select()
                .from(taskExecutionOwners)
                .where(eq(taskExecutionOwners.taskId, h.taskId))
            )[0],
          ).toEqual(before)
          expect(h.completed).toBe(1)
          return
        }
        // The SQLite COMMIT is synchronous; lose its response only after the real
        // commit, then observe the original durable tuple rather than an old read.
        const h = await taskHostFixture(harness.db, 'sync-commit-result-lost')
        const original = h.persistence.ownership.claimPendingIntent
        const error = new Error('synchronous committed return lost')
        h.persistence.ownership.claimPendingIntent = async function (input) {
          await original.call(this, input)
          throw error
        }
        await expect(h.claim()).rejects.toBe(error)
        expect(h.completed).toBe(1)
        expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('recovery-required')
        return
      }
      const binding = harness.applicationBinding
      if (binding.provider !== 'postgresql') throw new Error('row-lock engine fixture required')
      const pool = binding.runtime.providerPool()
      const commitEntered = deferred(),
        ackLockEntered = deferred(),
        allowCommit = deferred()
      const error = new Error('original COMMIT response lost')
      const rollbackError = new Error('original ROLLBACK response lost')
      let armed = false,
        faulted = false
      let serverCommit: Promise<void> | undefined
      const failedRows = (failure: Error): SqlRows => {
        const rejected = Promise.reject<readonly Record<string, unknown>[]>(failure)
        return Object.assign(rejected, {
          values: async () => {
            throw failure
          },
        })
      }
      const wrappedPool: PostgresqlPool = {
        unsafe: (query, parameters) => pool.unsafe(query, parameters),
        close: (options) => pool.close(options),
        async reserve(options): Promise<PostgresqlReservedConnection> {
          const real = await pool.reserve(options)
          let originalTransaction = false,
            releaseDeferred = false
          return {
            unsafe(query, parameters) {
              if (armed && !faulted && /^commit$/i.test(query.trim())) {
                faulted = true
                originalTransaction = true
                serverCommit = (async () => {
                  await allowCommit.promise
                  try {
                    await real.unsafe(outcome === 'commit' ? query : 'ROLLBACK', parameters)
                  } finally {
                    if (releaseDeferred) real.release()
                  }
                })()
                // Observe any server error immediately; the final test await still
                // checks that same real COMMIT promise and does not swallow it.
                void serverCommit.catch(() => undefined)
                commitEntered.resolve()
                return failedRows(error)
              }
              if (originalTransaction && /^rollback$/i.test(query.trim()))
                return failedRows(rollbackError)
              if (faulted && /task_execution_intents/i.test(query) && /for update/i.test(query))
                ackLockEntered.resolve()
              return real.unsafe(query, parameters)
            },
            release() {
              if (originalTransaction) releaseDeferred = true
              else real.release()
            },
          }
        },
      }
      const db = createPostgresqlDatabaseClient({
        ...binding.runtime,
        providerPool: () => wrappedPool,
      })
      const h = await taskHostFixture(db, `pending-real-${outcome}`)
      const before = outcome === 'rollback' ? await releasedOwner(db, h.taskId) : undefined
      armed = true
      let returned: unknown
      const claiming = h.claim().then(
        () => {
          throw new Error('lost claim result must not return a token')
        },
        (failure: unknown) => {
          returned = failure
        },
      )
      let drained = false
      let draining: Promise<void> | undefined
      try {
        await commitEntered.promise
        await ackLockEntered.promise
        // These are genuine MVCC reads on another real connection while the old
        // original connection still owns its claimed intent UPDATE row lock.
        expect(
          (
            await db
              .select()
              .from(taskExecutionIntents)
              .where(eq(taskExecutionIntents.id, h.intentId))
          )[0]?.state,
        ).toBe('pending')
        expect(
          await db
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, h.taskId)),
        ).toEqual(before === undefined ? [] : [before])
        expect(h.completed).toBe(0)
        expect(h.module.host!.finalizations.pendingForTask(h.taskId)).toBeDefined()
        draining = h.module.host!.finalizations.drain().then(() => {
          drained = true
        })
        await nextTurn()
        expect(drained).toBe(false)
        await db
          .update(tasks)
          .set({ name: 'resources remain editable' })
          .where(eq(tasks.id, h.taskId))
        expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
        allowCommit.resolve()
        await serverCommit
        await claiming
        await draining
        expect(returned).toBe(rollbackError)
        expect(h.completed).toBe(1)
        expect(drained).toBe(true)
        expect((await h.persistence.ownership.read(h.taskId))?.state).toBe(
          outcome === 'commit' ? 'recovery-required' : 'released',
        )
        if (before !== undefined)
          expect(
            (
              await db
                .select()
                .from(taskExecutionOwners)
                .where(eq(taskExecutionOwners.taskId, h.taskId))
            )[0],
          ).toEqual(before)
        expect(h.module.host!.finalizations.snapshot()).toEqual([])
      } finally {
        allowCommit.resolve()
        await serverCommit
        await claiming
        await draining
      }
    }, 15_000)
  }
})
