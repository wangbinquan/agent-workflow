// RFC-370 C2-W1: real Task claim/heartbeat SQL carries the original admitted work.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { taskExecutionIntents, taskExecutionOwners, tasks } from '@/db/schema'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import {
  taskHostWorkForToken,
  taskHostWorkCapture,
} from '@/modules/task-execution/application/taskHostAdmission'
import { clearTaskDriverLifecycleForTesting } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import {
  createProviderTaskExecutionModule,
  ProviderTaskExecutionModule,
} from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { nextTurn, taskHostFixture } from './helpers/taskHostExecution'

describeEachProvider('RFC-370 real Task host claim and original ACK callers', (harness) => {
  for (const mode of ['direct', 'provider'] as const) {
    test(`${mode}: original permit precedes capture; claimed/token/context shapes and receiver stay intact`, async () => {
      const h = await taskHostFixture(harness.db, `claim-${mode}`, { mode })
      const enter = h.module.claimGate.enter
      h.module.claimGate.enter = function () {
        h.events.push('permit')
        return enter.call(this)
      }
      const claimed = await h.claim()
      expect(h.events).toEqual(['permit', 'admission'])
      expect(Reflect.ownKeys(claimed)).toEqual(['intentId', 'token', 'permit'])
      expect(claimed.intentId).toBe(h.intentId)
      expect(Object.isFrozen(claimed.token)).toBe(true)
      expect(claimed.token.taskId).toBe(h.taskId)
      expect(claimed.token.daemonGeneration).toBe(h.module.daemonGeneration)
      expect(claimed.token.epoch).toBe(1)
      expect(claimed.token.ownerRevision).toBe(1)
      expect(h.completed).toBe(0)
      let idle = false
      const pending = h.module.awaitIdle().then(() => {
        idle = true
      })
      await nextTurn()
      expect(idle).toBe(false)
      h.module.claimGate.leave(claimed.permit)
      await pending
      const work = taskHostWorkForToken(claimed.token)!
      expect(Object.isFrozen(work)).toBe(true)
      expect(taskHostWorkCapture(work)).toBeDefined()
      const owner = await h.persistence.ownership.read(h.taskId)
      expect(owner?.ownerId).toBe(claimed.token.ownerId)
      expect(owner?.state).toBe('claimed')
    })

    test(`${mode}: unavailable preserves original intent error; successful SQL is wholly rolled back`, async () => {
      const h = await taskHostFixture(harness.db, `deny-${mode}`, { mode })
      h.deny('standby')
      await expect(h.claim('missing-intent')).rejects.toMatchObject({
        code: 'task-execution-owner-conflict',
      })
      await expect(h.claim()).rejects.toThrow('task-host-execution-unavailable: standby')
      await h.module.awaitIdle()
      expect(
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId)),
      ).toEqual([])
      const intents = await harness.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, h.intentId))
      expect(intents[0]?.state).toBe('pending')
      expect(intents[0]?.claimedEpoch).toBeNull()
      expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
      expect(h.leases).toHaveLength(0)
      expect(h.completed).toBe(0)
    })

    test(`${mode}: loss after the original SQL body rejects receipt and rolls back owner and intent`, async () => {
      const h = await taskHostFixture(harness.db, `rollback-${mode}`, {
        mode,
        beforeNewWork: () => lose(),
      })
      const lose = () => h.lose()
      const recording = harness.recordStatements()
      try {
        await expect(h.claim()).rejects.toThrow('host-execution-write-context-unavailable')
        expect(
          recording.statements.some(({ sql }) =>
            /insert into (?:(?:"agent_workflow"|agent_workflow)\.)?["`]?task_execution_owners["`]?\b/i.test(
              sql,
            ),
          ),
        ).toBe(true)
        expect(
          recording.statements.some(({ sql }) =>
            /update (?:(?:"agent_workflow"|agent_workflow)\.)?["`]?task_execution_intents["`]?\b/i.test(
              sql,
            ),
          ),
        ).toBe(true)
        expect(recording.statements.some(({ sql }) => /rollback/i.test(sql))).toBe(true)
      } finally {
        recording.stop()
      }
      expect(
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId)),
      ).toEqual([])
      expect(
        (
          await harness.db
            .select()
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.id, h.intentId))
        )[0]?.state,
      ).toBe('pending')
      expect(h.completed).toBe(1)
      expect(h.module.host!.finalizations.snapshot()).toEqual([])
      await h.module.awaitIdle()
    })
  }

  test('draining heartbeat keeps the old capture on the immutable refreshed token; unmatched token does not write', async () => {
    const h = await taskHostFixture(harness.db, 'heartbeat-old-work')
    const claim = await h.claim()
    h.module.claimGate.leave(claim.permit)
    const work = taskHostWorkForToken(claim.token)!
    h.lose()
    await h.selected.context.drain(h.receipt)
    const refreshed = await h.persistence.ownership.heartbeat({
      token: claim.token,
      now: Date.now(),
      leaseMs: 60_000,
    })
    expect(refreshed).not.toBe(claim.token)
    expect(Object.isFrozen(refreshed)).toBe(true)
    expect(refreshed.ownerRevision).toBe(2)
    expect(refreshed.ownerId).toBe(claim.token.ownerId)
    expect(refreshed.epoch).toBe(claim.token.epoch)
    expect(taskHostWorkForToken(refreshed)).toBe(work)
    expect(taskHostWorkCapture(taskHostWorkForToken(refreshed)!)).toBe(taskHostWorkCapture(work))
    const detached = createOwnershipToken({
      taskId: claim.token.taskId,
      identity: createWorkerIdentity({
        ownerId: claim.token.ownerId,
        daemonGeneration: claim.token.daemonGeneration,
      }),
      epoch: claim.token.epoch,
      ownerRevision: refreshed.ownerRevision,
      leaseUntil: refreshed.leaseUntil,
    })
    await expect(
      h.persistence.ownership.heartbeat({ token: detached, now: Date.now(), leaseMs: 60_000 }),
    ).rejects.toThrow('task-host-admitted-work-required')
    expect((await h.persistence.ownership.read(h.taskId))?.revision).toBe(2)
    expect(h.completed).toBe(0)
    expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
    await harness.db
      .update(tasks)
      .set({ name: 'resource-edit-after-loss' })
      .where(eq(tasks.id, h.taskId))
    expect((await harness.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.name).toBe(
      'resource-edit-after-loss',
    )
  })

  test('actual stopped attach preserves the original Task status and records exact recovery without a runtime proof', async () => {
    const h = await taskHostFixture(harness.db, 'unattached-loss')
    const controller = new AbortController()
    const module = h.module
    if (!(module instanceof ProviderTaskExecutionModule))
      throw new Error('provider fixture required')
    let claimedToken: Awaited<ReturnType<typeof h.claim>>['token'] | undefined
    const originalClaim = module.claimPersisted.bind(module)
    module.claimPersisted = async (input) => {
      const claimed = await originalClaim(input)
      claimedToken = claimed.token
      h.lose()
      h.module.runtimeRegistry.requestStop(claimed.token, 'original-stop-tombstone')
      return claimed
    }
    try {
      const result = await h.lifecycle.attach({
        taskId: h.taskId,
        intentId: h.intentId,
        controller,
      })
      expect(result).toEqual({ kind: 'not-attached' })
      expect(controller.signal.reason).toBe('original-stop-tombstone')
      expect(h.module.runtimeRegistry.hasTask(h.taskId)).toBe(false)
      const row = (
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId))
      )[0]!
      expect(row.state).toBe('recovery-required')
      expect(row.ownerId).toBe(claimedToken!.ownerId)
      expect(row.recoveryCode).toBe('task-host-driver-not-attached')
      expect(row.recoveryProofDigest).toBeNull()
      expect((await harness.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
        'running',
      )
      expect(h.completed).toBe(1)
      expect(h.module.host!.finalizations.snapshot()).toEqual([])
    } finally {
      clearTaskDriverLifecycleForTesting()
    }
  })

  test('selected composition refuses native persistence before creating any claim or driver', async () => {
    const h = await taskHostFixture(harness.db, 'incomplete-selection')
    expect(() =>
      createProviderTaskExecutionModule({
        daemonGeneration: 'mismatch',
        persistence: createTaskExecutionPersistence(harness.db),
        host: h.host,
      }),
    ).toThrow('task-host-write-selection-incomplete')
    expect(await harness.db.select().from(taskExecutionOwners)).toEqual([])
    expect(h.events).toEqual([])
  })
})
