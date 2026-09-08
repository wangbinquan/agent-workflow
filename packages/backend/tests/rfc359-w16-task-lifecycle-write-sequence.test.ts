// RFC-359 W16: preserve the two real lifecycle writers while sharing their
// CAS -> companion -> committed-event sequence. These cases first ran against
// the separate implementations; native transactions remain synchronous, and
// provider transactions observe uncommitted rows only through their own tx.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { canonicalJson } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
  tasks,
  workflows,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type { TaskNodeChangeV1 } from '@/modules/task-execution/domain/taskLifecycleCommittedEvent'
import { appendTaskLifecycleTransitionCommittedEventTx } from '@/modules/task-execution/infrastructure/taskLifecycleEventParticipant'
import { taskLifecycleWriteSequence } from '@/modules/task-execution/infrastructure/taskLifecycleWriteSequence'
import { writeTaskRuntimeLifecycleInTx } from '@/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import {
  setTaskStatus,
  transitionHumanGateTaskTx,
} from '@/platform/persistence/sqlite/taskLifecycle'
import {
  driveSyncProgram,
  executeTransactionStepSync,
} from '@/platform/persistence/transactionProgram'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_700_000_000_250
const INITIAL: TaskNodeChangeV1 = {
  nodeRunId: 'run-initial',
  nodeId: 'node-initial',
  status: 'done',
  cause: 'initial',
}
const ADDED: TaskNodeChangeV1 = {
  nodeRunId: 'run-added',
  nodeId: 'node-added',
  status: 'canceled',
  cause: null,
}

async function seedTask(
  db: ProviderNeutralDatabase,
  id: string,
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<void> {
  const workflowId = `workflow-${id}`
  await db.insert(workflows).values({ id: workflowId, name: workflowId, definition: '{}' })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: '{}',
    workflowVersion: 1,
    repoPath: '/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `task/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW - 1_000,
    runningSince: NOW - 100,
    runningMs: 50,
    lifecycleEventRevision: 4,
    errorSummary: 'previous-error',
    executionLineageId: id,
    lineageSlotPathJson: canonicalJson([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: 1 },
    ]),
    ...extra,
  })
  await db
    .update(committedEventFamilyCutovers)
    .set({ mode: 'dispatchable', epoch: 7, changedAt: NOW, changeRef: 'lifecycle-sequence-test' })
    .where(eq(committedEventFamilyCutovers.family, 'task-lifecycle'))
}

async function taskRow(db: ProviderNeutralDatabase, id: string) {
  const row = await db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (row === undefined) throw new Error(`missing fixture task ${id}`)
  return row
}

async function durableRows(db: ProviderNeutralDatabase) {
  return {
    events: await db.select().from(committedEvents).orderBy(committedEvents.id),
    heads: await db.select().from(committedEventAggregateHeads),
    deliveries: await db
      .select()
      .from(committedEventDeliveries)
      .orderBy(committedEventDeliveries.consumerId),
  }
}

const writeInput = (taskId: string) =>
  ({
    taskId,
    from: 'running',
    to: 'done',
    now: NOW,
    workspacePruneDecision: { prune: false },
    previousErrorSummary: 'previous-error',
  }) satisfies Parameters<typeof writeTaskRuntimeLifecycleInTx>[1]

describe('RFC-359 lifecycle native synchronous contract', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'native')
  })

  afterEach(() => {
    registerAfterCommitEventPump(null)
    db.$client.close()
  })

  test('human-gate result is immediate; an outer throw rolls back the CAS and event', async () => {
    const before = await taskRow(db, 'native')
    const sentinel = new Error('native outer rollback')
    expect(() =>
      dbTxSync(db, (tx) => {
        const result = transitionHumanGateTaskTx({
          tx,
          taskId: 'native',
          expectedTaskRevision: 4,
          transition: 'park-review',
          now: NOW,
          nodeChanges: [INITIAL],
        })
        expect(result).not.toBeInstanceOf(Promise)
        expect(result).toMatchObject({
          from: 'running',
          to: 'awaiting_review',
          taskRevision: 5,
          eventRefs: [{ eventId: 'task-lifecycle:native:5' }],
        })
        expect(tx.select().from(tasks).where(eq(tasks.id, 'native')).get()?.status).toBe(
          'awaiting_review',
        )
        expect(tx.select().from(committedEvents).all()).toHaveLength(1)
        throw sentinel
      }),
    ).toThrow(sentinel)
    expect(await taskRow(db, 'native')).toEqual(before)
    expect(await durableRows(db)).toEqual({ events: [], heads: [], deliveries: [] })
  })

  test('legacy companion is synchronous and defer runs after commit with the original receipt', async () => {
    const order: string[] = []
    const deferred: CommittedEventRef[] = []
    registerAfterCommitEventPump({
      async publishNow() {
        order.push('unexpected-publish')
      },
      nudge() {},
    })
    const result = await setTaskStatus({
      db,
      taskId: 'native',
      to: 'done',
      allowedFrom: ['running'],
      now: NOW,
      reason: 'native-companion',
      onTransitionTx(tx, transition, collector) {
        order.push('companion')
        expect(transition).toEqual({ from: 'running', to: 'done' })
        expect(tx.select().from(tasks).where(eq(tasks.id, 'native')).get()?.status).toBe('done')
        expect(tx.select().from(committedEvents).all()).toEqual([])
        tx.update(tasks).set({ name: 'companion-written' }).where(eq(tasks.id, 'native')).run()
        collector.addNodeChanges([ADDED])
      },
      deferCommittedEventPublication(refs) {
        order.push('defer')
        expect(db.$client.inTransaction).toBe(false)
        expect(db.select().from(committedEvents).all()).toHaveLength(1)
        deferred.push(...refs)
      },
    })
    expect(result).toEqual({ from: 'running', to: 'done' })
    expect(order).toEqual(['companion', 'defer'])
    expect(deferred).toMatchObject([{ eventId: 'task-lifecycle:native:5' }])
    expect((await taskRow(db, 'native')).name).toBe('companion-written')
    const [event] = (await durableRows(db)).events
    expect(JSON.parse(event?.payloadJson ?? 'null').payload.nodeChanges).toEqual([ADDED])
  })

  test('legacy companion failure preserves the error and rolls back before defer or publication', async () => {
    const before = await taskRow(db, 'native')
    const sentinel = new Error('native companion failed')
    let publications = 0
    await expect(
      setTaskStatus({
        db,
        taskId: 'native',
        to: 'done',
        allowedFrom: ['running'],
        now: NOW,
        reason: 'native-rollback',
        onTransitionTx(tx) {
          tx.update(tasks).set({ name: 'must-rollback' }).where(eq(tasks.id, 'native')).run()
          throw sentinel
        },
        deferCommittedEventPublication() {
          publications += 1
        },
      }),
    ).rejects.toBe(sentinel)
    expect(publications).toBe(0)
    expect(await taskRow(db, 'native')).toEqual(before)
    expect(await durableRows(db)).toEqual({ events: [], heads: [], deliveries: [] })
  })

  test('shared program completes the native companion and real append before returning to its transaction', async () => {
    const before = await taskRow(db, 'native')
    const sentinel = new Error('native shared companion rollback')
    const order: string[] = []
    const initial = [INITIAL]
    expect(() =>
      dbTxSync(db, (tx) => {
        const result = driveSyncProgram(
          taskLifecycleWriteSequence(
            tx,
            {
              ...writeInput('native'),
              extra: {
                workflowSnapshot: '{"nodes":[]}',
                workflowVersion: 2,
                refClosureJson: '{"items":[]}',
                workgroupConfigJson: '{"dw":{"phase":"executing"}}',
              },
              nodeChanges: initial,
              onTransitionTx(companionTx, transition, collector) {
                order.push('companion')
                expect(companionTx).toBe(tx)
                expect(transition).toEqual({ from: 'running', to: 'done' })
                expect(
                  companionTx.select().from(tasks).where(eq(tasks.id, 'native')).get(),
                ).toMatchObject({
                  status: 'done',
                  workflowSnapshot: '{"nodes":[]}',
                  workflowVersion: 2,
                  refClosureJson: '{"items":[]}',
                  workgroupConfigJson: '{"dw":{"phase":"executing"}}',
                })
                companionTx
                  .update(tasks)
                  .set({ name: 'same-transaction' })
                  .where(eq(tasks.id, 'native'))
                  .run()
                collector.addNodeChanges([ADDED])
              },
            },
            (appendTx, input) => {
              order.push('append')
              expect(appendTx).toBe(tx)
              expect(input.nodeChanges).toEqual([INITIAL, ADDED])
              return appendTaskLifecycleTransitionCommittedEventTx(appendTx, input)
            },
          ),
          executeTransactionStepSync,
        )
        order.push('returned')
        expect(result).not.toBeInstanceOf(Promise)
        expect(result).toMatchObject({ lifecycleEventRevision: 5 })
        expect(tx.select().from(committedEvents).all()).toHaveLength(1)
        throw sentinel
      }),
    ).toThrow(sentinel)
    expect(order).toEqual(['companion', 'append', 'returned'])
    expect(initial).toEqual([INITIAL])
    expect(await taskRow(db, 'native')).toEqual(before)
    expect(await durableRows(db)).toEqual({ events: [], heads: [], deliveries: [] })
  })
})

describeEachProvider('RFC-359 lifecycle physical write sequence', (harness) => {
  test('CAS, accounting, companion, collector and complete event persist on the same transaction', async () => {
    await seedTask(harness.db, 'complete')
    const before = await taskRow(harness.db, 'complete')
    const initial = [INITIAL]
    const result = await harness.session.transaction(async (tx) => {
      const changed = await writeTaskRuntimeLifecycleInTx(tx, {
        ...writeInput('complete'),
        expectedLifecycleRevision: 4,
        extra: {
          finishedAt: NOW,
          errorSummary: null,
          errorMessage: 'diagnostic',
          failedNodeId: 'failed-node',
          sourceTerminationFence: 'closed',
          sourceTerminationEffectRev: 3,
        },
        workspacePruneDecision: { prune: true, cause: 'webhook-terminal' },
        sourceTerminationEffectRef: 'source-effect',
        committedEventIdentity: {
          operationRef: 'operation',
          eventGroupId: 'group',
          eventGroupOrdinal: 2,
          correlationRef: 'correlation',
          causationRef: 'cause',
        },
        nodeChanges: initial,
        async onTransitionTx(companionTx, transition, collector) {
          expect(companionTx).toBe(tx)
          expect(transition).toEqual({ from: 'running', to: 'done' })
          expect((await taskRow(companionTx, 'complete')).status).toBe('done')
          expect((await durableRows(companionTx)).events).toEqual([])
          await companionTx
            .update(tasks)
            .set({ name: 'companion-written' })
            .where(eq(tasks.id, 'complete'))
          collector.addNodeChanges([ADDED])
        },
      })
      expect((await durableRows(tx)).events).toHaveLength(1)
      return changed
    })
    expect(initial).toEqual([INITIAL])
    expect(result).toMatchObject({
      lifecycleEventRevision: 5,
      eventRef: { eventId: 'task-lifecycle:complete:5', aggregate: { seq: 1 } },
    })
    expect(await taskRow(harness.db, 'complete')).toEqual({
      ...before,
      status: 'done',
      name: 'companion-written',
      runningMs: 150,
      runningSince: null,
      lifecycleEventRevision: 5,
      finishedAt: NOW,
      errorSummary: null,
      errorMessage: 'diagnostic',
      failedNodeId: 'failed-node',
      sourceTerminationFence: 'closed',
      sourceTerminationEffectRev: 3,
      workspacePruningAt: NOW,
      workspacePruneCause: 'webhook-terminal',
    })
    const payloadJson = canonicalJson({
      eventId: 'task-lifecycle:complete:5',
      eventGroupId: 'group',
      eventGroupOrdinal: 2,
      type: 'task.lifecycle-transitioned.v1',
      schemaVersion: 1,
      producer: 'task-execution',
      family: 'task-lifecycle',
      aggregate: { kind: 'task', id: 'complete', seq: 1 },
      operationRef: 'operation',
      correlationRef: 'correlation',
      causationRef: 'cause',
      occurredAt: new Date(NOW).toISOString(),
      payload: {
        taskId: 'complete',
        lifecycleRevision: 5,
        previousStatus: 'running',
        status: 'done',
        updatedAt: new Date(NOW).toISOString(),
        errorSummary: null,
        nodeChanges: [INITIAL, ADDED],
        workspacePruneClaim: {
          claimedAt: new Date(NOW).toISOString(),
          cause: 'webhook-terminal',
        },
        sourceTerminationEffectRef: 'source-effect',
        continuationHandoff: false,
      },
    })
    const durable = await durableRows(harness.db)
    expect(durable.events).toEqual([
      {
        id: 'task-lifecycle:complete:5',
        eventGroupId: 'group',
        eventGroupOrdinal: 2,
        producer: 'task-execution',
        family: 'task-lifecycle',
        eventType: 'task.lifecycle-transitioned.v1',
        schemaVersion: 1,
        aggregateKind: 'task',
        aggregateId: 'complete',
        aggregateSeq: 1,
        operationRef: 'operation',
        correlationRef: 'correlation',
        causationRef: 'cause',
        occurredAt: NOW,
        payloadJson,
        payloadDigest: sha256Hex(payloadJson),
        deliveryMode: 'dispatchable',
        producerEpoch: 7,
        createdAt: NOW,
      },
    ])
    expect(durable.deliveries.map(({ consumerId, state }) => ({ consumerId, state }))).toEqual([
      { consumerId: 'event-center.task-lifecycle', state: 'pending' },
      { consumerId: 'task-child-budget', state: 'pending' },
      { consumerId: 'task-execution-watch', state: 'pending' },
      { consumerId: 'task-terminal-gate-close', state: 'pending' },
      { consumerId: 'task-workspace-prune-nudge', state: 'pending' },
    ])
  })

  test('omitted error summary survives; explicit null clears it and a new stretch does not add parked time', async () => {
    await seedTask(harness.db, 'accounting', { status: 'pending', runningSince: null })
    await harness.session.transaction(async (tx) => {
      await writeTaskRuntimeLifecycleInTx(tx, {
        ...writeInput('accounting'),
        from: 'pending',
        to: 'running',
      })
      expect(await taskRow(tx, 'accounting')).toMatchObject({
        runningMs: 50,
        runningSince: NOW,
        errorSummary: 'previous-error',
      })
      await writeTaskRuntimeLifecycleInTx(tx, {
        ...writeInput('accounting'),
        to: 'awaiting_human',
        now: NOW + 200,
        extra: { errorSummary: null },
      })
      expect(await taskRow(tx, 'accounting')).toMatchObject({
        runningMs: 250,
        runningSince: null,
        errorSummary: null,
      })
      const { events } = await durableRows(tx)
      expect(events.map((row) => JSON.parse(row.payloadJson).payload.errorSummary)).toEqual([
        'previous-error',
        null,
      ])
    })
  })

  test.each([
    { name: 'status changed', row: { status: 'pending' }, input: {} },
    { name: 'revision changed', row: {}, input: { expectedLifecycleRevision: 3 } },
    { name: 'revival during prune', row: { workspacePruningAt: 1 }, input: { isRevival: true } },
    { name: 'revival after prune', row: { workspacePrunedAt: 1 }, input: { isRevival: true } },
    {
      name: 'duplicate prune claim',
      row: { workspacePruningAt: 1, workspacePruneCause: 'webhook-terminal' },
      input: { workspacePruneDecision: { prune: true, cause: 'webhook-terminal' } },
    },
  ] satisfies readonly {
    name: string
    row: Partial<typeof tasks.$inferInsert>
    input: Partial<Parameters<typeof writeTaskRuntimeLifecycleInTx>[1]>
  }[])('$name stops before companion and event', async ({ row, input }) => {
    await seedTask(harness.db, 'miss', row)
    const before = await taskRow(harness.db, 'miss')
    let companions = 0
    const result = await harness.session.transaction((tx) =>
      writeTaskRuntimeLifecycleInTx(tx, {
        ...writeInput('miss'),
        ...input,
        async onTransitionTx() {
          companions += 1
        },
      }),
    )
    expect(result).toBeNull()
    expect(companions).toBe(0)
    expect(await taskRow(harness.db, 'miss')).toEqual(before)
    expect(await durableRows(harness.db)).toEqual({ events: [], heads: [], deliveries: [] })
  })

  test('companion failure keeps the exact error and rolls back both real writes', async () => {
    await seedTask(harness.db, 'rollback')
    const before = await taskRow(harness.db, 'rollback')
    const sentinel = new Error('async companion failed')
    await expect(
      harness.session.transaction((tx) =>
        writeTaskRuntimeLifecycleInTx(tx, {
          ...writeInput('rollback'),
          async onTransitionTx(companionTx) {
            await companionTx
              .update(tasks)
              .set({ name: 'must-rollback' })
              .where(eq(tasks.id, 'rollback'))
            throw sentinel
          },
        }),
      ),
    ).rejects.toBe(sentinel)
    expect(await taskRow(harness.db, 'rollback')).toEqual(before)
    expect(await durableRows(harness.db)).toEqual({ events: [], heads: [], deliveries: [] })
  })

  test('append awaits the companion release; a later outer throw rolls back its completed event', async () => {
    await seedTask(harness.db, 'handshake')
    const before = await taskRow(harness.db, 'handshake')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const sentinel = new Error('outer rollback after append')
    await expect(
      harness.session.transaction(async (tx) => {
        const writing = writeTaskRuntimeLifecycleInTx(tx, {
          ...writeInput('handshake'),
          async onTransitionTx(companionTx) {
            order.push('entered')
            entered.resolve()
            await release.promise
            await companionTx
              .update(tasks)
              .set({ name: 'released' })
              .where(eq(tasks.id, 'handshake'))
            order.push('completed')
          },
        })
        await entered.promise
        expect((await taskRow(tx, 'handshake')).status).toBe('done')
        expect((await durableRows(tx)).events).toEqual([])
        expect(order).toEqual(['entered'])
        release.resolve()
        const result = await writing
        order.push('returned')
        expect(result?.eventRef).toMatchObject({ eventId: 'task-lifecycle:handshake:5' })
        expect(order).toEqual(['entered', 'completed', 'returned'])
        expect((await taskRow(tx, 'handshake')).name).toBe('released')
        expect((await durableRows(tx)).events).toHaveLength(1)
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(await taskRow(harness.db, 'handshake')).toEqual(before)
    expect(await durableRows(harness.db)).toEqual({ events: [], heads: [], deliveries: [] })
  })

  test('legacy cutover still commits the CAS and companion while returning a null receipt', async () => {
    await seedTask(harness.db, 'legacy', { runningSince: null })
    await harness.db
      .update(committedEventFamilyCutovers)
      .set({ mode: 'legacy' })
      .where(eq(committedEventFamilyCutovers.family, 'task-lifecycle'))
    let companions = 0
    const result = await harness.session.transaction((tx) =>
      writeTaskRuntimeLifecycleInTx(tx, {
        ...writeInput('legacy'),
        async onTransitionTx() {
          companions += 1
        },
      }),
    )
    expect(result).toEqual({ lifecycleEventRevision: 5, eventRef: null })
    expect(companions).toBe(1)
    expect(await taskRow(harness.db, 'legacy')).toMatchObject({
      status: 'done',
      runningMs: 50,
      runningSince: null,
    })
    expect(await durableRows(harness.db)).toEqual({ events: [], heads: [], deliveries: [] })
  })
})
