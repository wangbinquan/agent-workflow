// RFC-370 W2-R: real Task context and native SQL survive selected lease writes.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, runtimeSessionLeases, taskExecutionOwners } from '@/db/schema'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { createSelectedTaskRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/taskRuntimeSessionLeaseOperations'
import {
  createTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import type {
  NormalizedRuntimeSessionLeaseClaimInput,
  RuntimeSessionLeaseOperations,
  RuntimeSessionLeaseToken,
} from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'
import { describeEachProvider } from './helpers/eachProvider'
import { deferred, taskHostFixture } from './helpers/taskHostExecution'

async function leaseFixture(
  db: ProviderNeutralDatabase,
  tag: string,
  options: Parameters<typeof taskHostFixture>[2] = {},
) {
  const h = await taskHostFixture(db, `lease-${tag}-${ulid()}`, options)
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const runId = `run-${h.taskId}`,
    previousRunId = `previous-${h.taskId}`
  await db.insert(nodeRuns).values([
    {
      id: runId,
      taskId: h.taskId,
      nodeId: 'worker',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
    },
    {
      id: previousRunId,
      taskId: h.taskId,
      nodeId: 'worker',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    },
  ])
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence: h.persistence,
    legacyConnection: h.db,
    compatibility: { db: h.db },
    hostWriteCapture: taskHostWorkCapture(taskHostWorkForToken(claimed.token)!),
  })
  const native = createRuntimeSessionLeaseOperations(db)
  const operations: RuntimeSessionLeaseOperations = { ...native }
  const selected = createSelectedTaskRuntimeSessionLeaseOperations({
    db,
    operations,
    hostWrites: h.binding,
  })
  const input = (
    sessionId: string,
    protocol: 'opencode' | 'claude-code' = 'opencode',
  ): NormalizedRuntimeSessionLeaseClaimInput => ({
    protocol,
    sessionId,
    taskId: h.taskId,
    nodeId: 'worker',
    currentNodeRunId: runId,
    leaseNonceDigest: `nonce-${h.taskId}`,
    leasedAt: Date.now(),
  })
  const seedResume = async (
    sessionId: string,
    protocol: 'opencode' | 'claude-code' = 'opencode',
  ) => {
    await db.insert(runtimeSessionLeases).values({
      protocol,
      sessionId,
      taskId: h.taskId,
      nodeId: 'worker',
      createdNodeRunId: previousRunId,
      leaseNodeRunId: null,
      leaseNonceDigest: null,
      leasedAt: null,
      resetPending: false,
    })
  }
  const rows = async () => ({
    leases: await db
      .select()
      .from(runtimeSessionLeases)
      .where(eq(runtimeSessionLeases.taskId, h.taskId))
      .orderBy(runtimeSessionLeases.sessionId),
    runs: await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, h.taskId))
      .orderBy(nodeRuns.id),
    owners: await db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, h.taskId)),
  })
  return {
    h,
    runId,
    previousRunId,
    context,
    native,
    operations,
    selected,
    input,
    seedResume,
    rows,
  }
}

describeEachProvider('RFC-370 original selected Task runtime lease writes', (harness) => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol}: a received new session remains an issued ACK while old Task work is draining`, async () => {
      const f = await leaseFixture(harness.db, 'new-' + protocol)
      f.h.lose()
      const claim = f.input('received-' + f.h.taskId, protocol)
      const token = await runWithTaskExecutionContext(f.context, () => f.selected.claimNew(claim))
      expect(Reflect.ownKeys(token)).toEqual([
        'protocol',
        'sessionId',
        'nodeRunId',
        'leaseNonceDigest',
      ])
      expect(token.sessionId).toBe(claim.sessionId)
      expect(await f.selected.load(protocol, claim.sessionId)).toMatchObject({
        taskId: f.h.taskId,
        leaseNodeRunId: f.runId,
        leaseNonceDigest: claim.leaseNonceDigest,
      })
      expect(await f.selected.release(token)).toBe(true)
      expect((await f.selected.load(protocol, claim.sessionId))?.leaseNodeRunId).toBeNull()
      expect(f.h.completed).toBe(0)
      expect(f.h.leases).toHaveLength(1)
    })
    test(`${protocol}: resume admission rolls back original lease SQL after authority loss`, async () => {
      let loseAfterBody = false
      const f = await leaseFixture(harness.db, 'resume-rollback-' + protocol, {
        beforeNewWork: () => {
          if (loseAfterBody) f.h.lose()
        },
      })
      const session = 'resume-' + f.h.taskId
      await f.seedResume(session, protocol)
      const before = await f.rows()
      loseAfterBody = true
      await expect(
        runWithTaskExecutionContext(f.context, () =>
          f.selected.preclaimResume(f.input(session, protocol)),
        ),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(await f.rows()).toEqual(before)
      expect(f.h.completed).toBe(0)
      expect(f.h.leases).toHaveLength(1)
    })
  }
  test('confirm resume restores the original complete context outside an ambient Task and is new work', async () => {
    const f = await leaseFixture(harness.db, 'confirm')
    const session = 'resume-' + f.h.taskId
    await f.seedResume(session)
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.preclaimResume(f.input(session)),
    )
    expect(currentTaskExecutionContext()).toBeUndefined()
    expect(await f.selected.confirmResume(token)).toBe(true)
    expect((await f.rows()).runs.find((r) => r.id === f.runId)?.opencodeSessionId).toBe(session)
    expect(f.h.completed).toBe(0)
    expect(f.h.leases).toHaveLength(1)
  })
  test('confirm failure after the original SQL body rolls back and the original token can retry', async () => {
    let failConfirmation = false
    const error = new Error('original confirm receipt failed')
    const f = await leaseFixture(harness.db, 'confirm-retry', {
      beforeNewWork: () => {
        if (failConfirmation) throw error
      },
    })
    const session = 'resume-' + f.h.taskId
    await f.seedResume(session)
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.preclaimResume(f.input(session)),
    )
    const before = await f.rows()
    failConfirmation = true
    await expect(f.selected.confirmResume(token)).rejects.toBe(error)
    expect(await f.rows()).toEqual(before)
    failConfirmation = false
    expect(await f.selected.confirmResume(token)).toBe(true)
    expect(f.h.completed).toBe(0)
  })
  test('old issued release restores its complete Task context even inside a different Task', async () => {
    const f = await leaseFixture(harness.db, 'original-context'),
      other = await leaseFixture(harness.db, 'other-context')
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.claimNew(f.input('original-' + f.h.taskId)),
    )
    f.h.lose()
    await runWithTaskExecutionContext(other.context, async () => {
      expect(currentTaskExecutionContext()).toBe(other.context)
      expect(await f.selected.release(token)).toBe(true)
      expect(currentTaskExecutionContext()).toBe(other.context)
    })
    expect(f.h.completed).toBe(0)
    expect(other.h.completed).toBe(0)
  })
  test('reset and rotate keep the exact original successor token and issued cleanup during drain', async () => {
    const f = await leaseFixture(harness.db, 'rotate')
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.claimNew(f.input('outgoing-' + f.h.taskId)),
    )
    f.h.lose()
    expect(await f.selected.markResetPending(token)).toBe(true)
    const next = await f.selected.rotate(token, 'incoming-' + f.h.taskId)
    expect(next).not.toBe(token)
    expect(next).toEqual({ ...token, sessionId: 'incoming-' + f.h.taskId })
    expect(await f.selected.load('opencode', token.sessionId)).toBeUndefined()
    expect((await f.rows()).runs.find((r) => r.id === f.runId)?.opencodeSessionId).toBe(
      next.sessionId,
    )
    expect(await f.selected.discard(next)).toBe(true)
    expect(await f.selected.load('opencode', next.sessionId)).toBeUndefined()
    expect(f.h.completed).toBe(0)
  })
  test('issued SQL rollback preserves all original rows and the same token can retry release', async () => {
    let failAck = false
    const error = new Error('original issued lease ACK failed')
    const f = await leaseFixture(harness.db, 'ack-retry', {
      beforeIssuedAck: () => {
        if (failAck) throw error
      },
    })
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.claimNew(f.input('ack-' + f.h.taskId)),
    )
    const before = await f.rows()
    failAck = true
    await expect(f.selected.release(token)).rejects.toBe(error)
    expect(await f.rows()).toEqual(before)
    failAck = false
    f.h.lose()
    expect(await f.selected.release(token)).toBe(true)
    expect(f.h.completed).toBe(0)
  })
  test('a structurally copied runtime token cannot replace the original captured token', async () => {
    const f = await leaseFixture(harness.db, 'identity')
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.claimNew(f.input('identity-' + f.h.taskId)),
    )
    const before = await f.rows()
    await expect(f.selected.release({ ...token })).rejects.toThrow(
      'task-runtime-session-original-work-required',
    )
    expect(await f.rows()).toEqual(before)
    expect(await f.selected.release(token)).toBe(true)
  })
  test('selected claim requires the original complete Task context and does not create a native fallback', async () => {
    const f = await leaseFixture(harness.db, 'missing-context'),
      before = await f.rows()
    await expect(f.selected.claimNew(f.input('context-' + f.h.taskId))).rejects.toThrow(
      'task-host-execution-context-required',
    )
    expect(await f.rows()).toEqual(before)
    expect(f.h.completed).toBe(0)
  })
  test('a denied new resume preserves the original native owner-missing error', async () => {
    const f = await leaseFixture(harness.db, 'original-error')
    f.h.lose()
    await expect(
      runWithTaskExecutionContext(f.context, () =>
        f.selected.preclaimResume(f.input('missing-' + f.h.taskId)),
      ),
    ).rejects.toMatchObject({
      code: 'runtime-session-conflict',
      reason: 'owner-missing',
    })
    expect((await f.rows()).leases).toEqual([])
    expect(f.h.completed).toBe(0)
  })
  test('the native release false result is preserved without completing or reacquiring Task work', async () => {
    const f = await leaseFixture(harness.db, 'false')
    const token = await runWithTaskExecutionContext(f.context, () =>
      f.selected.claimNew(f.input('false-' + f.h.taskId)),
    )
    await harness.db
      .update(runtimeSessionLeases)
      .set({ leaseNonceDigest: 'different-original-holder' })
      .where(eq(runtimeSessionLeases.sessionId, token.sessionId))
    const before = await f.rows()
    expect(await f.selected.release(token)).toBe(false)
    expect(await f.rows()).toEqual(before)
    expect(f.h.completed).toBe(0)
    expect(f.h.leases).toHaveLength(1)
  })
  test('adapter captures the original native claim method and receiver before the first await', async () => {
    const f = await leaseFixture(harness.db, 'captured'),
      entered = deferred(),
      allow = deferred()
    const original = f.native.claimNew
    let receivedToken: RuntimeSessionLeaseToken | undefined
    const operations: RuntimeSessionLeaseOperations = {
      ...f.native,
      async claimNew(input) {
        expect(this).toBe(operations)
        expect(currentTaskExecutionContext()).toBe(f.context)
        entered.resolve()
        await allow.promise
        expect(currentTaskExecutionContext()).toBe(f.context)
        receivedToken = await original.call(f.native, input)
        return receivedToken
      },
    }
    const selected = createSelectedTaskRuntimeSessionLeaseOperations({
      db: harness.db,
      operations,
      hostWrites: f.h.binding,
    })
    const pending = runWithTaskExecutionContext(f.context, () =>
      selected.claimNew(f.input('captured-' + f.h.taskId)),
    )
    await entered.promise
    operations.claimNew = async () => {
      throw new Error('replacement must not consume old method')
    }
    allow.resolve()
    const token = await pending
    expect<RuntimeSessionLeaseToken | undefined>(token).toBe(receivedToken)
    expect(await selected.release(token)).toBe(true)
    expect(f.h.completed).toBe(0)
  })
})
