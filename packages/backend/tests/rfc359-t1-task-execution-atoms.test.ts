// RFC-359 W1-T1（前置）—— task-execution 的三个中立原子在两个引擎上各跑一遍：
//   ① committed-event append（唯一实现：`platform/events/committed/append.ts`）
//   ② node_runs 铸造参与者（`nodeRunMintParticipant.ts`，替代 PostgreSQL 副本）
//   ③ human-gate 决定接受原子 + 两个 provider 共用的 db-owning 端口实现
//      （`taskDecisionParticipant.ts`，替代 sqlite/postgresql 两份 TaskDecisionPersistence）
//
// 这些以前是「SQLite 同步一份、PostgreSQL 异步一份」的成对适配器，PostgreSQL 那份从未在真库上
// 跑过（dual-provider-parity-audit-2026-09-04）。同一段断言现在在两个引擎上都必须绿。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventDeliveries,
  committedEvents,
  nodeRuns,
  taskExecutionIntents,
  tasks,
  workflows,
} from '@/db/schema'
import { humanGateNodeProjectionFence } from '@/modules/task-execution/domain/humanGateContinuation'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import {
  DatabaseTaskDecisionPersistence,
  acceptHumanGateDecisionTx,
} from '@/modules/task-execution/infrastructure/taskDecisionParticipant'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { committedEventGroupId } from '@/platform/events/committed/types'
import { ConcurrentTaskTransition } from '@/platform/persistence/sqlite/taskLifecycle'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const TASK_ID = 'task_rfc359_atoms'
const NOW = 1_788_969_612_066

async function seedTask(
  db: ProviderNeutralDatabase,
  status: 'awaiting_human' | 'running' = 'awaiting_human',
): Promise<number> {
  await db.insert(workflows).values({
    id: 'wf_rfc359_atoms',
    name: 'rfc359',
    description: '',
    definition: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: TASK_ID,
    name: 'rfc359',
    workflowId: 'wf_rfc359_atoms',
    workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
    repoPath: '/tmp/aw-rfc359',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${TASK_ID}`,
    status,
    inputs: '{}',
    startedAt: NOW,
    executionLineageId: TASK_ID,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: TASK_ID, workflowRevision: null },
    ]),
  })
  const row = await db
    .select({ revision: tasks.lifecycleEventRevision })
    .from(tasks)
    .where(eq(tasks.id, TASK_ID))
    .get()
  if (row === undefined) throw new Error('seed failed')
  return row.revision
}

function lifecycleEvent(ordinal: number, status: 'running' | 'done') {
  return {
    producer: 'task-execution' as const,
    family: 'task-lifecycle' as const,
    type: 'task.lifecycle-transitioned.v1' as const,
    aggregate: { kind: 'task' as const, id: TASK_ID },
    operationRef: `rfc359:${ordinal}`,
    eventGroupId: committedEventGroupId('task-execution', `rfc359:${ordinal}`),
    eventGroupOrdinal: 0,
    occurredAt: NOW + ordinal,
    payload: { taskId: TASK_ID, status },
    consumers: [{ id: 'rfc359-consumer', deliveryClass: 'rebuildable' as const }],
  }
}

describeEachProvider('RFC-359 T1 —— committed-event 的唯一 append 实现', (harness) => {
  test('落行、分配聚合序号、写消费者投递；同组同序的重放返回同一事件；不同内容的重放抛错', async () => {
    await seedTask(harness.db)
    const first = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, lifecycleEvent(1, 'running')),
    )
    expect(first.cutover.mode).toBe('dispatchable')
    expect(first.eventRef).toMatchObject({
      producer: 'task-execution',
      family: 'task-lifecycle',
      aggregate: { kind: 'task', id: TASK_ID, seq: 1 },
      eventGroupOrdinal: 0,
    })
    const second = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, lifecycleEvent(2, 'done')),
    )
    expect(second.eventRef?.aggregate.seq).toBe(2)

    const replay = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, lifecycleEvent(1, 'running')),
    )
    expect(replay.eventRef?.eventId).toBe(first.eventRef?.eventId)
    await expect(
      harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, lifecycleEvent(1, 'done')),
      ),
    ).rejects.toThrow(/replay conflicts with immutable event/)

    const deliveries = await harness.db
      .select({ eventId: committedEventDeliveries.eventId, state: committedEventDeliveries.state })
      .from(committedEventDeliveries)
      .where(eq(committedEventDeliveries.consumerId, 'rfc359-consumer'))
    expect(deliveries.map((row) => row.state)).toEqual(['pending', 'pending'])
    expect((await harness.db.select({ id: committedEvents.id }).from(committedEvents)).length).toBe(
      2,
    )
  })

  test('事件与业务写入同一事务：体内抛错 ⇒ 事件与序号一起回滚', async () => {
    await seedTask(harness.db)
    await expect(
      harness.session.transaction(async (tx) => {
        await appendCommittedEvent(tx, lifecycleEvent(1, 'running'))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await harness.db.select({ id: committedEvents.id }).from(committedEvents)).toEqual([])
    const again = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, lifecycleEvent(1, 'running')),
    )
    expect(again.eventRef?.aggregate.seq, '回滚后的序号必须从 1 重新分配').toBe(1)
  })
})

describeEachProvider('RFC-359 T1 —— node_runs 铸造参与者', (harness) => {
  test('替换铸造与旧代 merge 状态的退役在同一事务提交（移植自 rfc349 的 SQLite 用例）', async () => {
    await seedTask(harness.db, 'running')
    await harness.session.transaction(async (tx) => {
      const mint = createNodeRunMintParticipantInTx(tx)
      await mint.mint({
        id: '01RFC359000000000000000001',
        taskId: TASK_ID,
        nodeId: 'review-node',
        status: 'awaiting_review',
        cause: 'initial',
      })
      await tx
        .update(nodeRuns)
        .set({ mergeState: 'pending-merge' })
        .where(eq(nodeRuns.id, '01RFC359000000000000000001'))
        .run()
      await mint.mint({
        id: '01RFC359000000000000000002',
        taskId: TASK_ID,
        nodeId: 'review-node',
        status: 'awaiting_review',
        cause: 'review-iterate',
      })
    })
    expect(
      await harness.db
        .select({ id: nodeRuns.id, mergeState: nodeRuns.mergeState })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, TASK_ID))
        .orderBy(nodeRuns.id),
    ).toEqual([
      { id: '01RFC359000000000000000001', mergeState: 'abandoned' },
      { id: '01RFC359000000000000000002', mergeState: null },
    ])
  })
})

describeEachProvider('RFC-359 T1 —— human-gate 决定的接受原子', (harness) => {
  const decision = (expectedTaskRevision: number, operationId = 'op_rfc359') => ({
    taskId: TASK_ID,
    gate: { kind: 'clarify' as const, ref: 'clarify:rfc359' },
    expectedTaskRevision,
    expectedNodeProjection: humanGateNodeProjectionFence([]),
    continuationLineage: { sourceNodeRunIds: [], rerunNodeRunIds: [] },
    operationId,
    now: NOW + 10,
  })

  test('释放 awaiting_human → pending、准入一条 gate-continuation、产出一条 committed event', async () => {
    const revision = await seedTask(harness.db)
    const accepted = await new DatabaseTaskDecisionPersistence(harness.session).accept(
      decision(revision),
    )
    expect(accepted.taskRevision).toBe(revision + 1)
    expect(accepted.eventRefs.map((ref) => ref.eventGroupId)).toEqual([
      committedEventGroupId('collaboration', 'op_rfc359'),
    ])
    const task = await harness.db
      .select({ status: tasks.status, revision: tasks.lifecycleEventRevision })
      .from(tasks)
      .where(eq(tasks.id, TASK_ID))
      .get()
    // release-human 的目标态由 shared 的 targetForTaskEvent({kind:'resume'}) 决定：回到 pending 交给调度器。
    expect(task).toEqual({ status: 'pending', revision: revision + 1 })
    const intent = await harness.db
      .select({ kind: taskExecutionIntents.kind, state: taskExecutionIntents.state })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, accepted.continuationRef))
      .get()
    expect(intent).toEqual({ kind: 'gate-continuation', state: 'pending' })
  })

  test('修订号过期 ⇒ ConcurrentTaskTransition（ConflictError），任务纹丝不动', async () => {
    const revision = await seedTask(harness.db)
    const error = await new DatabaseTaskDecisionPersistence(harness.session)
      .accept(decision(revision + 5))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(error).toBeInstanceOf(ConcurrentTaskTransition)
    expect(error).toBeInstanceOf(ConflictError)
    const task = await harness.db
      .select({ status: tasks.status, revision: tasks.lifecycleEventRevision })
      .from(tasks)
      .where(eq(tasks.id, TASK_ID))
      .get()
    expect(task).toEqual({ status: 'awaiting_human', revision })
  })

  test('准入被已有 pending continuation 拒绝 ⇒ 已写入的状态跃迁与事件一起回滚（跨步原子性）', async () => {
    const revision = await seedTask(harness.db)
    await harness.db.insert(taskExecutionIntents).values({
      id: 'intent_pending_rfc359',
      taskId: TASK_ID,
      kind: 'gate-continuation',
      state: 'pending',
      source: 'internal',
      requestHash: 'other',
      payloadJson: '{}',
      executionLineageId: TASK_ID,
      continuationSlotKey: 'slot',
      slotPathJson: encodeLineageSlotPath([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: TASK_ID, workflowRevision: null },
      ]),
      operationGeneration: 0,
      replayAuthorizationId: null,
      authorizationScopeJson: null,
      expectedTaskRevision: revision,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await expect(
      harness.session.transaction(
        async (tx) => await acceptHumanGateDecisionTx(tx, decision(revision)),
      ),
    ).rejects.toThrow(/already has an active continuation/)
    const task = await harness.db
      .select({ status: tasks.status, revision: tasks.lifecycleEventRevision })
      .from(tasks)
      .where(eq(tasks.id, TASK_ID))
      .get()
    expect(task, '跃迁必须随准入失败一起回滚').toEqual({ status: 'awaiting_human', revision })
    expect(
      await harness.db
        .select({ id: committedEvents.id })
        .from(committedEvents)
        .where(
          and(
            eq(committedEvents.producer, 'task-execution'),
            eq(committedEvents.aggregateId, TASK_ID),
          ),
        ),
      '事件必须随准入失败一起回滚',
    ).toEqual([])
  })
})
