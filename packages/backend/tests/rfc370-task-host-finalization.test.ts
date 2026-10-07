// RFC-370 C2-W1 D2/D3: actual registry retirement, durable ACK and cleanup retry.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import {
  nodeRuns,
  taskExecutionEffects,
  taskExecutionEffectAttempts,
  taskExecutionIntents,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { ProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import { clearTaskDriverLifecycleForTesting } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import {
  assertTaskExecutionContext,
  taskExecutionHostWriteCapture,
  runWithTaskExecutionContext,
  currentTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkForToken,
  taskHostWorkCapture,
} from '@/modules/task-execution/application/taskHostAdmission'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import {
  withTaskReviewMutationLock,
  __hasTaskReviewMutationQueueForTesting,
} from '@/services/reviewMutationCoordinator'
import { describeEachProvider } from './helpers/eachProvider'
import {
  deferred,
  nextTurn,
  seedTaskHostIntent,
  taskHostFixture,
} from './helpers/taskHostExecution'
import {
  scheduledTaskRuntime,
  taskExecutionResourceBinding,
} from './helpers/integrationTriggerResourceBinding'

afterEach(() => clearTaskDriverLifecycleForTesting())

async function attach(h: Awaited<ReturnType<typeof taskHostFixture>>) {
  const controller = new AbortController()
  const result = await h.lifecycle.attach({ taskId: h.taskId, intentId: h.intentId, controller })
  if (result.kind !== 'attached') throw new Error('real selected driver was not attached')
  assertTaskExecutionContext(result.attachment.execution)
  const execution = runWithTaskExecutionContext(
    result.attachment.execution,
    () => currentTaskExecutionContext()!,
  )
  expect(execution).toBe(result.attachment.execution)
  expect(taskExecutionHostWriteCapture(execution)).toBe(
    taskHostWorkCapture(taskHostWorkForToken(execution.token)!),
  )
  expect(execution.db).toBe(h.db)
  expect(Object.isFrozen(execution)).toBe(true)
  expect(h.module.host!.finalizations.snapshot()).toEqual([
    { taskId: h.taskId, phase: 'active', error: undefined },
  ])
  return { controller, execution }
}

function ownerWrites(sql: string): boolean {
  return /\bupdate\b.*\btask_execution_owners\b/i.test(sql)
}
function effectWrites(sql: string): boolean {
  return /\bupdate\b.*\btask_execution_effect(?:s|_attempts|_fences)\b/i.test(sql)
}

async function processEffect(
  h: Awaited<ReturnType<typeof taskHostFixture>>,
  token: Parameters<typeof taskHostWorkForToken>[0],
  managed = true,
) {
  const runId = `run-${h.taskId}`
  await h.db.insert(nodeRuns).values({
    id: runId,
    taskId: h.taskId,
    nodeId: 'worker',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
  })
  const slotPath = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: h.taskId, workflowRevision: 1 },
  ]
  const slotPathJson = canonicalJson(slotPath)
  const effect = await h.persistence.effects.prepareAndAcquire({
    token,
    intentId: h.intentId,
    operationKey: `${h.taskId}:process`,
    executionLineageId: h.taskId,
    operationFamilyKey: operationFamilyKey({
      executionLineageId: h.taskId,
      slotPath,
      effectKind: 'process',
      stableActionOrdinal: 'managed-agent',
    }),
    operationGeneration: 0,
    kind: 'process',
    requestHash: requestHash({ argv: ['/opt/opencode'], cwd: '/tmp/worktree' }),
    slotPathJson,
    slotPathDigest: requestHash(slotPathJson),
    candidateId: `agent:${runId}`,
    recoveryClass: managed ? 'managed-process-preactivation' : 'fixture-unresolved-process',
    classifierVersion: 'rfc328-managed-process-v1',
    transportPolicyVersion: 'rfc328-preactivation-v1',
    retryAuthority: 'none',
    resourceKeys: [`process:${h.taskId}:${runId}`],
  })
  await h.db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
  return effect
}

describeEachProvider('RFC-370 original Task driver finalization lifetime', (harness) => {
  test('the original heartbeat timer drains its captured Promise before cleanup reads a revision or completes old work', async () => {
    const heartbeatEntered = deferred(),
      allowHeartbeat = deferred(),
      registryReleased = deferred()
    const h = await taskHostFixture(harness.db, 'heartbeat-in-flight')
    const ownership = h.persistence.ownership,
      heartbeat = ownership.heartbeat,
      read = ownership.read
    let heartbeats = 0,
      reads = 0
    ownership.heartbeat = async function (input) {
      expect(this).toBe(ownership)
      heartbeats++
      heartbeatEntered.resolve()
      await allowHeartbeat.promise
      return heartbeat.call(this, input)
    }
    ownership.read = async function (taskId) {
      reads++
      return read.call(this, taskId)
    }
    const driver = await attach(h)
    const before = await read.call(ownership, h.taskId)
    ownership.heartbeat = async () => {
      throw new Error('replacement heartbeat must not receive old work')
    }
    const registry = h.module.runtimeRegistry,
      release = registry.release
    registry.release = function (input) {
      const result = release.call(this, input)
      registryReleased.resolve()
      return result
    }
    let finished = false,
      drained = false
    let finalizing: Promise<void> | undefined, draining: Promise<void> | undefined
    try {
      await heartbeatEntered.promise // The production timer itself fires after 15 seconds.
      finalizing = h.lifecycle
        .releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
        .then(() => {
          finished = true
        })
      await registryReleased.promise
      draining = h.module.host!.finalizations.drain().then(() => {
        drained = true
      })
      await nextTurn()
      expect(heartbeats).toBe(1)
      expect(reads).toBe(0)
      expect(finished).toBe(false)
      expect(drained).toBe(false)
      expect(h.completed).toBe(0)
      expect(registry.tokenForTask(h.taskId)).toBeNull()
      await withTaskReviewMutationLock(h.taskId, async () => {
        await h.db
          .update(tasks)
          .set({ name: 'editable while original heartbeat is pending' })
          .where(eq(tasks.id, h.taskId))
      })
      expect(__hasTaskReviewMutationQueueForTesting(h.taskId)).toBe(false)
      allowHeartbeat.resolve()
      await finalizing
      await draining
      expect(reads).toBe(1)
      expect(finished).toBe(true)
      expect(drained).toBe(true)
      expect(h.completed).toBe(1)
      expect((await read.call(ownership, h.taskId))?.revision).toBe(before!.revision + 2)
      expect((await read.call(ownership, h.taskId))?.state).toBe('released')
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(h.completed).toBe(1)
    } finally {
      allowHeartbeat.resolve()
      await finalizing
      await draining
    }
  }, 60_000)

  test('a rejected writer synchronization ACK retains the released registry barrier and retries before the original read', async () => {
    const error = new Error('first heartbeat writer synchronization ACK rejected')
    let rejectAck = false,
      ackCalls = 0
    const h = await taskHostFixture(harness.db, 'heartbeat-sync-retry', {
      beforeIssuedAck: () => {
        ackCalls++
        if (rejectAck) {
          rejectAck = false
          throw error
        }
      },
    })
    const driver = await attach(h)
    const ownership = h.persistence.ownership,
      read = ownership.read
    let reads = 0
    ownership.read = async function (taskId) {
      expect(this).toBe(ownership)
      reads++
      return read.call(this, taskId)
    }
    const barrier = h.module.host!.finalizations.pendingForTask(h.taskId)!
    rejectAck = true
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(error)
    expect(reads).toBe(0)
    expect(ackCalls).toBe(1)
    expect(h.module.runtimeRegistry.tokenForTask(h.taskId)).toBeNull()
    let settled = false
    const settling = h.module.runtimeRegistry.awaitReleasedSettled(h.taskId).then(() => {
      settled = true
    })
    await nextTurn()
    expect(settled).toBe(false)
    expect(h.completed).toBe(0)
    expect(h.module.host!.finalizations.pendingForTask(h.taskId)).toBe(barrier)
    ownership.read = async () => {
      throw new Error('replacement read must not receive old work')
    }
    await withTaskReviewMutationLock(h.taskId, async () => {
      await h.db
        .update(tasks)
        .set({ name: 'editable during ACK retry' })
        .where(eq(tasks.id, h.taskId))
    })
    await h.module.host!.finalizations.retryPending()
    await settling
    await barrier
    expect(reads).toBe(1)
    expect(settled).toBe(true)
    expect(h.completed).toBe(1)
    expect((await read.call(ownership, h.taskId))?.state).toBe('released')
    expect(h.module.host!.finalizations.snapshot()).toEqual([])
  }, 15_000)

  for (const outcome of ['commit', 'rollback'] as const) {
    test(`${outcome}: a rejected heartbeat reply waits for the true server writer termination before fixing the cleanup revision`, async () => {
      const heartbeatReturned = deferred<unknown>()
      const error = new Error('original heartbeat response lost')
      if (harness.capabilities.isolation === 'exclusive') {
        let rollbackArmed = false
        const h = await taskHostFixture(harness.db, `heartbeat-sqlite-${outcome}`, {
          beforeIssuedAck: () => {
            if (rollbackArmed) {
              rollbackArmed = false
              throw error // After the real UPDATE and ACK consumption, before COMMIT.
            }
          },
        })
        const ownership = h.persistence.ownership,
          heartbeat = ownership.heartbeat
        ownership.heartbeat = async function (input) {
          try {
            await heartbeat.call(this, input)
            throw error // Lose a commit reply only after the synchronous real commit.
          } catch (failure) {
            heartbeatReturned.resolve(failure)
            throw failure
          }
        }
        const driver = await attach(h)
        const before = await ownership.read(h.taskId)
        rollbackArmed = outcome === 'rollback'
        expect(await heartbeatReturned.promise).toBe(error)
        await nextTurn()
        expect(driver.controller.signal.reason).toBe('task-execution-stale-owner')
        const after = await ownership.read(h.taskId)
        if (outcome === 'rollback') expect(after).toEqual(before)
        else expect(after?.revision).toBe(before!.revision + 1)
        await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
        expect((await ownership.read(h.taskId))?.revision).toBe(after!.revision + 1)
        expect((await ownership.read(h.taskId))?.state).toBe('released')
        expect(h.completed).toBe(1)
        return
      }

      const binding = harness.applicationBinding
      if (binding.provider !== 'postgresql') throw new Error('row-lock engine fixture required')
      const pool = binding.runtime.providerPool()
      const commitEntered = deferred(),
        ackLockEntered = deferred(),
        allowServerTermination = deferred()
      const rollbackError = new Error('original heartbeat rollback response lost')
      let armed = false,
        faulted = false
      let serverTermination: Promise<void> | undefined
      const failedRows = (failure: Error): SqlRows =>
        Object.assign(Promise.reject<readonly Record<string, unknown>[]>(failure), {
          values: async () => {
            throw failure
          },
        })
      const wrappedPool: PostgresqlPool = {
        unsafe: (query, parameters) => pool.unsafe(query, parameters),
        close: (options) => pool.close(options),
        async reserve(options): Promise<PostgresqlReservedConnection> {
          const real = await pool.reserve(options)
          let heartbeatWriter = false,
            retained = false,
            releaseDeferred = false
          return {
            unsafe(query, parameters) {
              if (armed && ownerWrites(query) && /last_heartbeat_at/i.test(query))
                heartbeatWriter = true
              if (heartbeatWriter && !faulted && /^commit$/i.test(query.trim())) {
                faulted = true
                retained = true
                serverTermination = (async () => {
                  await allowServerTermination.promise
                  try {
                    await real.unsafe(outcome === 'commit' ? query : 'ROLLBACK', parameters)
                  } finally {
                    if (releaseDeferred) real.release()
                  }
                })()
                void serverTermination.catch(() => undefined)
                commitEntered.resolve()
                return failedRows(error)
              }
              if (retained && /^rollback$/i.test(query.trim())) return failedRows(rollbackError)
              if (faulted && /task_execution_owners/i.test(query) && /for update/i.test(query))
                ackLockEntered.resolve()
              return real.unsafe(query, parameters)
            },
            release() {
              if (retained) releaseDeferred = true
              else real.release()
            },
          }
        },
      }
      const db = createPostgresqlDatabaseClient({
        ...binding.runtime,
        providerPool: () => wrappedPool,
      })
      const h = await taskHostFixture(db, `heartbeat-pg-${outcome}`)
      const ownership = h.persistence.ownership,
        heartbeat = ownership.heartbeat,
        read = ownership.read
      ownership.heartbeat = async function (input) {
        try {
          return await heartbeat.call(this, input)
        } catch (failure) {
          heartbeatReturned.resolve(failure)
          throw failure
        }
      }
      const driver = await attach(h)
      const before = await read.call(ownership, h.taskId)
      let reads = 0
      ownership.read = async function (taskId) {
        reads++
        return read.call(this, taskId)
      }
      armed = true
      let finished = false,
        drained = false
      let finalizing: Promise<void> | undefined, draining: Promise<void> | undefined
      try {
        await commitEntered.promise
        expect(await heartbeatReturned.promise).toBe(rollbackError)
        await nextTurn()
        expect(driver.controller.signal.reason).toBe('task-execution-stale-owner')
        finalizing = h.lifecycle
          .releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
          .then(() => {
            finished = true
          })
        await ackLockEntered.promise
        draining = h.module.host!.finalizations.drain().then(() => {
          drained = true
        })
        // This independent real connection sees the committed pre-heartbeat row.
        expect(
          (
            await harness.db
              .select()
              .from(taskExecutionOwners)
              .where(eq(taskExecutionOwners.taskId, h.taskId))
          )[0]?.revision,
        ).toBe(before!.revision)
        await nextTurn()
        expect(reads).toBe(0)
        expect(finished).toBe(false)
        expect(drained).toBe(false)
        expect(h.completed).toBe(0)
        await withTaskReviewMutationLock(h.taskId, async () => {
          await db
            .update(tasks)
            .set({ name: 'editable while true writer remains' })
            .where(eq(tasks.id, h.taskId))
        })
        allowServerTermination.resolve()
        await serverTermination
        await finalizing
        await draining
        expect(reads).toBe(1)
        expect((await read.call(ownership, h.taskId))?.revision).toBe(
          before!.revision + (outcome === 'commit' ? 2 : 1),
        )
        expect((await read.call(ownership, h.taskId))?.state).toBe('released')
        expect(h.completed).toBe(1)
        expect(h.module.host!.finalizations.snapshot()).toEqual([])
      } finally {
        allowServerTermination.resolve()
        await serverTermination
        await finalizing
        await draining
      }
    }, 60_000)
  }

  test('owner rejection after registry.settle retries the exact original method/receiver and completes only after real ACK', async () => {
    let finalized = 0
    const h = await taskHostFixture(harness.db, 'owner-retry', {
      finalizeWorkspace: async () => {
        finalized++
      },
    })
    const driver = await attach(h)
    const oldBarrier = h.module.host!.finalizations.pendingForTask(h.taskId)!
    const owner = h.persistence.ownership,
      release = owner.releaseAfterStop
    const effects = h.persistence.effects,
      resolve = effects.resolveQuiescedManagedProcesses
    let releases = 0,
      resolutions = 0
    const originalError = new Error('original owner reply rejected')
    owner.releaseAfterStop = async function (input) {
      expect(this).toBe(owner)
      releases++
      if (releases === 1) throw originalError
      return release.call(this, input)
    }
    effects.resolveQuiescedManagedProcesses = async function (input) {
      expect(this).toBe(effects)
      resolutions++
      return resolve.call(this, input)
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect(h.module.runtimeRegistry.tokenForTask(h.taskId)).toBeNull()
    expect(h.module.host!.finalizations.pendingForTask(h.taskId)).toBe(oldBarrier)
    expect(h.module.host!.finalizations.snapshot()).toEqual([
      { taskId: h.taskId, phase: 'pending', error: originalError },
    ])
    expect(h.completed).toBe(0)
    expect(finalized).toBe(0)
    owner.releaseAfterStop = async () => {
      throw new Error('replacement must not receive old work')
    }
    effects.resolveQuiescedManagedProcesses = async () => {
      throw new Error('known resolution must not replay')
    }
    await harness.db
      .update(tasks)
      .set({ name: 'edit while finalization pending' })
      .where(eq(tasks.id, h.taskId))
    await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
    await oldBarrier
    expect(releases).toBe(2)
    expect(resolutions).toBe(1)
    expect(finalized).toBe(1)
    expect(h.completed).toBe(1)
    expect((await owner.read(h.taskId))?.state).toBe('released')
    expect(
      (
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, h.intentId))
      )[0]?.state,
    ).toBe('completed')
    expect(h.module.host!.finalizations.snapshot()).toEqual([])
  }, 15_000)

  test('workspace rejection survives registry removal; concurrent finally and drain reuse one retry without replaying SQL', async () => {
    const workspaceAck = deferred(),
      retryEntered = deferred()
    const originalError = new Error('first workspace cleanup rejected')
    let finalized = 0
    const h = await taskHostFixture(harness.db, 'workspace-retry', {
      finalizeWorkspace: async (taskId) => {
        expect(taskId).toBe('workspace-retry')
        finalized++
        if (finalized === 1) throw originalError
        retryEntered.resolve()
        await workspaceAck.promise
      },
    })
    const driver = await attach(h)
    h.leases[0]!.complete = () => {
      throw new Error('replacement lease completion must not receive old work')
    }
    const collection = h.module.host!.finalizations,
      barrier = collection.pendingForTask(h.taskId)!
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect(h.module.runtimeRegistry.tokenForTask(h.taskId)).toBeNull()
    expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('released')
    const recording = harness.recordStatements()
    try {
      const one = h.lifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: driver.controller,
      })
      const two = h.lifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: driver.controller,
      })
      let drained = false
      const drain = collection.drain().then(() => {
        drained = true
      })
      await retryEntered.promise
      await nextTurn()
      expect(finalized).toBe(2)
      expect(h.completed).toBe(0)
      expect(drained).toBe(false)
      expect(collection.pendingForTask(h.taskId)).toBe(barrier)
      expect(
        recording.statements.filter(({ sql }) => ownerWrites(sql) || effectWrites(sql)),
      ).toEqual([])
      workspaceAck.resolve()
      await Promise.all([one, two, drain, barrier])
      expect(h.completed).toBe(1)
      expect(collection.snapshot()).toEqual([])
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(finalized).toBe(2)
      expect(h.completed).toBe(1)
    } finally {
      workspaceAck.resolve()
      recording.stop()
    }
  }, 15_000)

  test('committed owner reply loss is confirmed from the original token/intent/proof and never replays the owner write', async () => {
    const h = await taskHostFixture(harness.db, 'owner-response-loss')
    const driver = await attach(h)
    const owner = h.persistence.ownership,
      release = owner.releaseAfterStop
    const originalError = new Error('owner commit reply lost')
    let calls = 0
    owner.releaseAfterStop = async function (input) {
      calls++
      await release.call(this, input)
      throw originalError
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect((await owner.read(h.taskId))?.state).toBe('released')
    expect(h.completed).toBe(0)
    const recording = harness.recordStatements()
    try {
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(recording.statements.filter(({ sql }) => ownerWrites(sql))).toEqual([])
      expect(calls).toBe(1)
      expect(h.completed).toBe(1)
    } finally {
      recording.stop()
    }
  }, 15_000)

  test('a different persistent proof cannot acknowledge the old owner transfer', async () => {
    const h = await taskHostFixture(harness.db, 'different-proof')
    const driver = await attach(h)
    const owner = h.persistence.ownership,
      release = owner.releaseAfterStop
    const originalError = new Error('owner reply absent')
    owner.releaseAfterStop = async function (input) {
      await release.call(this, input)
      throw originalError
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    const row = (
      await harness.db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, h.taskId))
    )[0]!
    await harness.db
      .update(taskExecutionOwners)
      .set({ recoveryProofDigest: 'different-completion-proof' })
      .where(eq(taskExecutionOwners.taskId, h.taskId))
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(h.completed).toBe(0)
    expect(h.module.host!.finalizations.snapshot()[0]?.phase).toBe('pending')
    await harness.db
      .update(taskExecutionOwners)
      .set({ recoveryProofDigest: row.recoveryProofDigest })
      .where(eq(taskExecutionOwners.taskId, h.taskId))
    await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
    expect(h.completed).toBe(1)
  }, 15_000)

  test('a rejected unattached recovery ACK stays pending and retries without inventing a runtime stop proof', async () => {
    const h = await taskHostFixture(harness.db, 'unattached-ack-retry')
    const module = h.module
    if (!(module instanceof ProviderTaskExecutionModule))
      throw new Error('provider fixture required')
    const claim = module.claimPersisted,
      owner = h.persistence.ownership,
      mark = owner.markRecoveryRequired
    let calls = 0
    const originalError = new Error('unattached recovery reply rejected')
    owner.markRecoveryRequired = async function (input) {
      calls++
      if (calls === 1) throw originalError
      return mark.call(this, input)
    }
    module.claimPersisted = async function (input) {
      const result = await claim.call(this, input)
      h.lose()
      module.runtimeRegistry.requestStop(result.token, 'original-stop')
      return result
    }
    const controller = new AbortController()
    await expect(
      h.lifecycle.attach({ taskId: h.taskId, intentId: h.intentId, controller }),
    ).rejects.toBe(originalError)
    await module.awaitIdle()
    expect(module.runtimeRegistry.tokenForTask(h.taskId)).toBeNull()
    expect(h.completed).toBe(0)
    expect(module.host!.finalizations.snapshot()).toEqual([
      { taskId: h.taskId, phase: 'pending', error: originalError },
    ])
    await module.host!.finalizations.retryPending()
    expect(calls).toBe(2)
    expect(h.completed).toBe(1)
    const row = (
      await harness.db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, h.taskId))
    )[0]!
    expect(row.state).toBe('recovery-required')
    expect(row.recoveryProofDigest).toBeNull()
    expect((await harness.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
      'running',
    )
  }, 15_000)

  test('committed process-resolution reply loss uses the original durable receipt; known effects are not written twice', async () => {
    const h = await taskHostFixture(harness.db, 'process-response-loss')
    const driver = await attach(h)
    await processEffect(h, driver.execution.token)
    const effects = h.persistence.effects,
      resolve = effects.resolveQuiescedManagedProcesses
    const originalError = new Error('process resolution reply lost')
    let calls = 0
    effects.resolveQuiescedManagedProcesses = async function (input) {
      calls++
      await resolve.call(this, input)
      throw originalError
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('claimed')
    expect(h.completed).toBe(0)
    const recording = harness.recordStatements()
    try {
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(recording.statements.filter(({ sql }) => effectWrites(sql))).toEqual([])
      expect(calls).toBe(1)
      expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('released')
      expect(h.completed).toBe(1)
    } finally {
      recording.stop()
    }
  }, 15_000)

  test('committed outcome-unknown closure reply loss retains the exact closure proof and intent fact', async () => {
    const h = await taskHostFixture(harness.db, 'closure-response-loss')
    const driver = await attach(h)
    await processEffect(h, driver.execution.token, false)
    const effects = h.persistence.effects,
      close = effects.closeOutcomeUnknownAndRelease
    const originalError = new Error('closure reply lost')
    let calls = 0
    effects.closeOutcomeUnknownAndRelease = async function (input) {
      calls++
      await close.call(this, input)
      throw originalError
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect(
      (
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, h.taskId))
      )[0]?.recoveryCode,
    ).toBe('task-execution-outcome-unknown')
    expect(h.completed).toBe(0)
    const recording = harness.recordStatements()
    try {
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(
        recording.statements.filter(({ sql }) => ownerWrites(sql) || effectWrites(sql)),
      ).toEqual([])
      expect(calls).toBe(1)
      expect(
        (
          await harness.db
            .select()
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.id, h.intentId))
        )[0]?.state,
      ).toBe('failed')
      expect(h.completed).toBe(1)
    } finally {
      recording.stop()
    }
  }, 15_000)

  test('selected background keeps its actual ACK retry loop after authority loss and drain waits for real workspace ACK', async () => {
    const workspaceAck = deferred(),
      retryEntered = deferred()
    let finalized = 0
    const originalError = new Error('background workspace retry')
    const h = await taskHostFixture(harness.db, 'background-cleanup', {
      finalizeWorkspace: async () => {
        finalized++
        if (finalized === 1) throw originalError
        retryEntered.resolve()
        await workspaceAck.promise
      },
    })
    const driver = await attach(h)
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    const scheduled = scheduledTaskRuntime(harness.db),
      identity = composeIdentityAccess(harness.db)
    const control = composeTaskExecutionProviderBackground({
      module: h.module,
      recovery: h.persistence.recoveryAdministration,
      taskHasDriver: (id) => h.module.runtimeRegistry.hasTask(id),
      buildScheduleLaunch: () => async () => {
        throw new Error('new schedule must not dispatch')
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
              taskExecutionResources: taskExecutionResourceBinding(harness.db),
            },
          },
        },
        { current: () => h.grant.current() },
      )
      h.lose()
      await h.selected.context.drain(h.receipt)
      await handle.quiesceAuthorityLoss()
      expect(driver.controller.signal.aborted).toBe(false)
      const index = timeout.mock.calls.findIndex((args) => args[1] === 1_000)
      const args = timeout.mock.calls[index]!,
        timer = timeout.mock.results[index]!
      if (timer.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('actual ACK timer missing')
      clearTimeout(timer.value)
      Reflect.apply(args[0], undefined, args.slice(2))
      await retryEntered.promise
      let drained = false
      const draining = handle.drain().then(() => {
        drained = true
      })
      await nextTurn()
      expect(finalized).toBe(2)
      expect(h.completed).toBe(0)
      expect(drained).toBe(false)
      await harness.db
        .update(tasks)
        .set({ name: 'editable after loss' })
        .where(eq(tasks.id, h.taskId))
      expect((await harness.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.name).toBe(
        'editable after loss',
      )
      workspaceAck.resolve()
      await draining
      expect(drained).toBe(true)
      expect(h.completed).toBe(1)
      expect(h.module.host!.finalizations.snapshot()).toEqual([])
    } finally {
      workspaceAck.resolve()
      if (handle !== undefined) {
        await handle.quiesceAuthorityLoss()
        await handle.drain()
      }
      timeout.mockRestore()
    }
  }, 15_000)

  test('late finally after the first precheck releases the original review lock and blocks new claim until actual cleanup', async () => {
    const claimEntered = deferred(),
      allowFirstClaim = deferred(),
      registryReleased = deferred(),
      registryWaiting = deferred(),
      allowOwner = deferred(),
      workspaceEntered = deferred(),
      workspaceAck = deferred()
    let finalized = 0,
      claims = 0,
      registryWaits = 0
    const h = await taskHostFixture(harness.db, 'late-finally-window', {
      finalizeWorkspace: async () => {
        finalized++
        if (finalized === 1) {
          workspaceEntered.resolve()
          await workspaceAck.promise
        }
      },
    })
    const module = h.module
    if (!(module instanceof ProviderTaskExecutionModule))
      throw new Error('provider fixture required')
    const claim = module.claimPersisted,
      wait = module.runtimeRegistry.awaitReleasedSettled,
      release = module.runtimeRegistry.release
    module.claimPersisted = async function (input) {
      claims++
      if (claims === 1) {
        claimEntered.resolve()
        await allowFirstClaim.promise
      }
      return claim.call(this, input)
    }
    module.runtimeRegistry.awaitReleasedSettled = async function (taskId) {
      registryWaits++
      if (registryWaits === 2) {
        await registryReleased.promise
        registryWaiting.resolve()
      }
      await wait.call(this, taskId)
    }
    module.runtimeRegistry.release = function (input) {
      const result = release.call(this, input)
      if (result !== null) registryReleased.resolve()
      return result
    }
    const owner = h.persistence.ownership,
      releaseOwner = owner.releaseAfterStop
    owner.releaseAfterStop = async function (input) {
      await allowOwner.promise
      return releaseOwner.call(this, input)
    }
    const oldController = new AbortController(),
      newController = new AbortController()
    let second: ReturnType<typeof h.lifecycle.attach> | undefined,
      finalizing: Promise<void> | undefined
    try {
      const first = h.lifecycle.attach({
        taskId: h.taskId,
        intentId: h.intentId,
        controller: oldController,
      })
      await claimEntered.promise
      second = h.lifecycle.attach({
        taskId: h.taskId,
        intentId: 'second-intent',
        controller: newController,
      })
      allowFirstClaim.resolve()
      expect((await first).kind).toBe('attached')
      const originalBarrier = module.host!.finalizations.pendingForTask(h.taskId)!
      finalizing = h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: oldController })
      await registryWaiting.promise
      allowOwner.resolve()
      await workspaceEntered.promise
      await nextTurn()
      expect(module.runtimeRegistry.tokenForTask(h.taskId)).toBeNull()
      expect(module.host!.finalizations.pendingForTask(h.taskId)).toBe(originalBarrier)
      expect(claims).toBe(1)
      expect(h.leases).toHaveLength(1)
      expect(h.completed).toBe(0)
      expect(__hasTaskReviewMutationQueueForTesting(h.taskId)).toBe(false)
      await withTaskReviewMutationLock(h.taskId, async () => {
        await harness.db
          .update(tasks)
          .set({ name: 'lock released for resources' })
          .where(eq(tasks.id, h.taskId))
      })
      await seedTaskHostIntent(harness.db, h.taskId, 'second-intent', 1)
      workspaceAck.resolve()
      await finalizing
      const next = await second
      expect(next.kind).toBe('attached')
      expect(claims).toBe(2)
      expect(registryWaits).toBeGreaterThanOrEqual(3)
      expect(h.completed).toBe(1)
      const token = module.runtimeRegistry.tokenForTask(h.taskId)!
      expect(token.epoch).toBe(2)
      expect(module.runtimeRegistry.controllerFor(token)).toBe(newController)
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: oldController })
      expect(finalized).toBe(1)
      expect(h.completed).toBe(1)
      expect(module.runtimeRegistry.tokenForTask(h.taskId)).toBe(token)
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: newController })
      expect(finalized).toBe(2)
      expect(h.completed).toBe(2)
    } finally {
      allowFirstClaim.resolve()
      allowOwner.resolve()
      workspaceAck.resolve()
      await finalizing
      await second
    }
  }, 15_000)
  test('process reply confirmation preserves historical attempts when one later attempt changes the shared effect', async () => {
    const h = await taskHostFixture(harness.db, 'process-history-response-loss')
    const driver = await attach(h)
    const effects = h.persistence.effects
    const first = await processEffect(h, driver.execution.token)
    await effects.settle({
      token: driver.execution.token,
      effectId: first.effectId,
      attemptId: first.attemptId,
      state: 'retry-authorized',
      applicationEvidence: 'definitely-not-applied',
      retryAuthority: 'transport-policy',
    })
    const [effect] = await h.db
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.id, first.effectId))
    const [historical] = await h.db
      .select()
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.id, first.attemptId))
    if (effect === undefined || historical === undefined)
      throw new Error('real effect history missing')
    const second = await effects.prepareAndAcquire({
      token: driver.execution.token,
      intentId: h.intentId,
      operationKey: effect.operationKey,
      executionLineageId: effect.executionLineageId,
      operationFamilyKey: effect.operationFamilyKey,
      operationGeneration: effect.operationGeneration,
      kind: effect.kind,
      requestHash: effect.requestHash,
      slotPathJson: effect.slotPathJson,
      slotPathDigest: effect.slotPathDigest,
      candidateId: historical.candidateId,
      recoveryClass: historical.recoveryClass,
      classifierVersion: historical.classifierVersion,
      transportPolicyVersion: historical.transportPolicyVersion,
      retryAuthority: 'transport-policy',
      resourceKeys: first.resourceKeys,
    })
    expect(second.effectId).toBe(first.effectId)
    expect(second.attemptNo).toBe(2)
    const resolve = effects.resolveQuiescedManagedProcesses
    const originalError = new Error('historical process resolution reply lost')
    let calls = 0
    effects.resolveQuiescedManagedProcesses = async function (input) {
      calls++
      await resolve.call(this, input)
      throw originalError
    }
    await expect(
      h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller }),
    ).rejects.toBe(originalError)
    expect(h.completed).toBe(0)
    const recording = harness.recordStatements()
    try {
      await h.lifecycle.releaseAndFinalize({ taskId: h.taskId, controller: driver.controller })
      expect(recording.statements.filter(({ sql }) => effectWrites(sql))).toEqual([])
      expect(calls).toBe(1)
      expect((await h.persistence.ownership.read(h.taskId))?.state).toBe('released')
      expect(h.completed).toBe(1)
      expect(
        (
          await h.db
            .select()
            .from(taskExecutionEffectAttempts)
            .where(eq(taskExecutionEffectAttempts.id, first.attemptId))
        )[0],
      ).toEqual(historical)
    } finally {
      recording.stop()
    }
  }, 15_000)
})
