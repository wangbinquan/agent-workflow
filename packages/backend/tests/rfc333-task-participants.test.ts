// RFC-333 T5 — human-gate park/decision participants share one SQLite
// transaction with domain projections, the canonical lifecycle event, exactly
// one continuation intent, and the linked pre-drive rollback effect.

import { describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import {
  clarifyRounds,
  collaborationGateOperations,
  nodeRuns,
  taskQuestions,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionOwners,
  committedEvents,
  tasks,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition/commandContext'
import { ClarifyGateOpenPreparation } from '@/modules/collaboration/application/prepareClarifyGateOpen'
import { composeTaskExecutionHumanGateAdapter } from '@/modules/collaboration/application/adapters/task-execution-human-gate-adapter'
import { SqliteClarifyQuestionSnapshotReader } from '@/modules/collaboration/infrastructure/sqliteClarifyQuestionSnapshotReader'
import { SqliteHumanGateOperationStore } from '@/modules/collaboration/infrastructure/sqliteHumanGateOperationStore'
import { createManualQuestionOpen } from '@/modules/collaboration/public/commands'
import { GateContinuationEffectStep } from '@/modules/task-execution/application/drive/gateContinuationEffectStep'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { TaskParkTransaction } from '@/modules/task-execution/application/parkTaskAtHumanGate'
import {
  ManualQuestionParkRequired,
  ManualQuestionParkTransaction,
} from '@/modules/task-execution/application/parkManualQuestions'
import type { GateWorkspaceRollbackExecutor } from '@/modules/task-execution/application/ports/gateWorkspaceRollback'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import { LegacyHumanGateTaskLifecycle } from '@/modules/task-execution/infrastructure/legacyHumanGateTaskLifecycle'
import {
  assertNoManualQuestionParkObligationTx,
  bindTaskDecisionParticipantInTx,
} from '@/modules/task-execution/composition/humanGate'
import {
  humanGateNodeProjectionFence,
  type HumanGateNodeProjectionMember,
} from '@/modules/task-execution/domain/humanGateContinuation'
import {
  encodeLineageSlotPath,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { trySetTaskStatus } from '@/services/lifecycle'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_788_969_900_000

function slotPath(taskId: string): readonly LineageSlot[] {
  return [{ stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 }]
}

function seedTask(
  db: ReturnType<typeof createInMemoryDb>,
  taskId: string,
  status: 'pending' | 'running' | 'awaiting_review' | 'awaiting_human' | 'failed' | 'interrupted',
): void {
  db.insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-rfc333',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/rfc333',
      worktreePath: '/tmp/rfc333',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status,
      inputs: '{}',
      startedAt: NOW - 1_000,
      executionLineageId: taskId,
      lineageSlotPathJson: encodeLineageSlotPath(slotPath(taskId)),
    })
    .run()
}

function seedDecisionNodes(db: ReturnType<typeof createInMemoryDb>, taskId: string) {
  const sourceNodeRunId = `${taskId}-source`
  const rerunNodeRunId = `${taskId}-rerun`
  db.insert(nodeRuns)
    .values([
      {
        id: sourceNodeRunId,
        taskId,
        nodeId: 'writer',
        status: 'canceled',
        retryIndex: 0,
        iteration: 0,
        reviewIteration: 0,
        preSnapshot: 'a'.repeat(40),
        rerunCause: null,
        supersededByReview: 'rejected',
        rolledBack: false,
        operationGeneration: 0,
      },
      {
        id: rerunNodeRunId,
        taskId,
        nodeId: 'writer',
        status: 'pending',
        retryIndex: 1,
        iteration: 0,
        reviewIteration: 0,
        rerunCause: 'review-reject',
        operationGeneration: 0,
      },
    ])
    .run()
  return { sourceNodeRunId, rerunNodeRunId }
}

function projectionMember(row: typeof nodeRuns.$inferSelect): HumanGateNodeProjectionMember {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
}

function projectionFence(
  tx: DbTxSync | ReturnType<typeof createInMemoryDb>,
  ids: readonly string[],
) {
  return humanGateNodeProjectionFence(
    tx
      .select()
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
      .all()
      .map(projectionMember),
  )
}

function submitDecision(
  tx: DbTxSync,
  input: {
    taskId: string
    sourceNodeRunId: string
    rerunNodeRunId: string
    expectedTaskRevision?: number
    expectedFence?: ReturnType<typeof humanGateNodeProjectionFence>
    rollback?: boolean
    module: ReturnType<typeof createTaskExecutionTestModule>
  },
) {
  const ids = [input.sourceNodeRunId, input.rerunNodeRunId]
  return bindTaskDecisionParticipantInTx(tx, input.module.effects).acceptGateDecisionTx({
    taskId: input.taskId,
    gate: { kind: 'review', ref: `review:${input.taskId}:1` },
    expectedTaskRevision: input.expectedTaskRevision ?? 1,
    expectedNodeProjection: input.expectedFence ?? projectionFence(tx, ids),
    continuationLineage: {
      sourceNodeRunIds: [input.sourceNodeRunId],
      rerunNodeRunIds: [input.rerunNodeRunId],
    },
    ...(input.rollback === false
      ? {}
      : {
          workspaceRollbackPlan: {
            operationId: `operation:${input.taskId}`,
            planDigest: 'b'.repeat(64),
          },
        }),
    operationId: `operation:${input.taskId}`,
    now: NOW,
  })
}

function prepareOpenOperation(input: {
  db: ReturnType<typeof createInMemoryDb>
  store: SqliteHumanGateOperationStore
  taskId: string
}) {
  const askingNodeRunId = `${input.taskId}-asking`
  input.db
    .insert(nodeRuns)
    .values({
      id: askingNodeRunId,
      taskId: input.taskId,
      nodeId: 'writer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    .run()
  const result = new ClarifyGateOpenPreparation(
    input.db,
    input.store,
    new SqliteClarifyQuestionSnapshotReader(),
  ).prepare({
    taskId: input.taskId,
    kind: 'self',
    askingNodeId: 'writer',
    askingNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: 'clarify',
    targetConsumerNodeId: null,
    parentNodeRunId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: '[{"id":"question-1","title":"Question?"}]',
    questions: [{ id: 'question-1', title: 'Question?' }],
    truncationWarningsJson: null,
    sourceSnapshotDigest: 'a'.repeat(64),
    idempotencyKey: `open:${input.taskId}`,
    expectedTaskRevision: 1,
    now: NOW + 1,
  })
  if (result.kind !== 'prepared') throw new Error('expected prepared clarify operation')
  return result
}

describe('RFC-333 T5 TaskParkTx', () => {
  test('consumes the prepared gate and parks task + lifecycle event in one owned transaction', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-park'
    seedTask(db, taskId, 'running')
    const module = createTaskExecutionTestModule('daemon-rfc333-park')
    const intent = module.intents.submit({
      db,
      intentId: 'intent-rfc333-park',
      request: {
        taskId,
        kind: 'launch',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: slotPath(taskId),
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
      now: NOW,
    })
    const claimed = module.claim({ db, intentId: intent.intentId, now: NOW })
    module.claimGate.leave(claimed.permit)
    const operations = new SqliteHumanGateOperationStore()
    const opening = prepareOpenOperation({ db, store: operations, taskId })
    const prepared = opening.prepared
    const parked = new TaskParkTransaction(
      module.ownership,
      composeTaskExecutionHumanGateAdapter(),
      new LegacyHumanGateTaskLifecycle(),
    ).park({ db, token: claimed.token, prepared, now: NOW + 2 })

    expect(parked).toEqual({
      taskRevision: 2,
      gateRevision: 1,
      nodeProjectionDigest: opening.manifest.nodeProjectionDigest,
      committedEventRef: opening.manifest.committedEventRef,
    })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 2,
    })
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, prepared.operationId))
        .get(),
    ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
    expect(
      db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all(),
    ).toHaveLength(1)
    expect(
      db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all(),
    ).toHaveLength(1)
    expect(
      db
        .select()
        .from(committedEvents)
        .where(eq(committedEvents.id, `task-lifecycle:${taskId}:2`))
        .get(),
    ).toMatchObject({
      producer: 'task-execution',
      family: 'task-lifecycle',
      aggregateId: taskId,
      deliveryMode: 'dispatchable',
    })
  })

  test('task park failure rolls collaboration consumption back to prepared', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-park-fault'
    seedTask(db, taskId, 'running')
    const module = createTaskExecutionTestModule('daemon-rfc333-park-fault')
    const intent = module.intents.submit({
      db,
      request: {
        taskId,
        kind: 'launch',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: slotPath(taskId),
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
      now: NOW,
    })
    const claimed = module.claim({ db, intentId: intent.intentId, now: NOW })
    module.claimGate.leave(claimed.permit)
    const operations = new SqliteHumanGateOperationStore()
    const opening = prepareOpenOperation({ db, store: operations, taskId })
    const prepared = opening.prepared
    db.run(sql`
      CREATE TRIGGER rfc333_fail_task_park
      BEFORE UPDATE OF status ON tasks
      BEGIN SELECT RAISE(ABORT, 'rfc333-task-park-fault'); END
    `)

    expect(() =>
      new TaskParkTransaction(
        module.ownership,
        composeTaskExecutionHumanGateAdapter(),
        new LegacyHumanGateTaskLifecycle(),
      ).park({
        db,
        token: claimed.token,
        prepared,
        now: NOW + 2,
      }),
    ).toThrow()
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, prepared.operationId))
        .get()?.state,
    ).toBe('prepared')
  })
})

describe('RFC-333 T7 manual-question durable park obligation', () => {
  const createManual = (db: ReturnType<typeof createInMemoryDb>, taskId: string) =>
    createManualQuestionOpen(createCollaborationCommandContext({ db }), {
      taskId,
      title: 'Investigate this edge case',
      body: 'Re-run the fixer with this instruction.',
      targetNodeId: 'fixer',
      actorUserId: 'user-rfc333',
      now: NOW + 10,
    })

  for (const status of [
    'pending',
    'running',
    'awaiting_review',
    'awaiting_human',
    'failed',
    'interrupted',
  ] as const) {
    test(`create on ${status} preserves task state and records the exact obligation`, () => {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `task-333-manual-${status}`
      seedTask(db, taskId, status)
      const created = createManual(db, taskId)

      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(status)
      expect(
        db.select().from(taskQuestions).where(eq(taskQuestions.id, created.questionId)).get(),
      ).toMatchObject({
        sourceKind: 'manual',
        roleKind: 'designer',
        stagedBy: 'user-rfc333',
        overrideTargetNodeId: 'fixer',
      })
      expect(
        db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, created.operationId))
          .get(),
      ).toMatchObject({
        state: 'prepared',
        operationKind: 'manual-question-open',
        gateKind: 'questions',
      })
    })
  }

  test('question-row failure rolls the operation insert back in the same transaction', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-create-fault'
    seedTask(db, taskId, 'running')
    db.run(sql`
      CREATE TRIGGER rfc333_fail_manual_question
      BEFORE INSERT ON task_questions
      BEGIN SELECT RAISE(ABORT, 'rfc333-manual-question-fault'); END
    `)
    expect(() => createManual(db, taskId)).toThrow('rfc333-manual-question-fault')
    expect(db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all()).toEqual(
      [],
    )
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .all(),
    ).toEqual([])
  })

  test('HTTP-side create does not steal the active owner; that owner parks at settle', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-owner-settle'
    seedTask(db, taskId, 'running')
    const module = createTaskExecutionTestModule('daemon-rfc333-manual')
    const intent = module.intents.submit({
      db,
      request: {
        taskId,
        kind: 'launch',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: slotPath(taskId),
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
      now: NOW,
    })
    const claimed = module.claim({ db, intentId: intent.intentId, now: NOW })
    module.claimGate.leave(claimed.permit)
    const ownerBefore = db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .get()!

    const created = createManual(db, taskId)
    const ownerAfterCreate = db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .get()!
    expect(ownerAfterCreate).toMatchObject({
      ownerId: ownerBefore.ownerId,
      epoch: ownerBefore.epoch,
      revision: ownerBefore.revision,
      state: 'claimed',
    })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')

    const settled = new ManualQuestionParkTransaction(
      module.ownership,
      composeTaskExecutionHumanGateAdapter(),
      new LegacyHumanGateTaskLifecycle(),
    ).settle({ db, taskId, token: claimed.token, now: NOW + 20 })
    expect(settled).toEqual({ consumed: 1, parked: true })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 2,
    })
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get(),
    ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
  })

  test('a dispatched question completes its stale obligation without parking', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-dispatched-before-settle'
    seedTask(db, taskId, 'running')
    const created = createManual(db, taskId)
    db.update(taskQuestions)
      .set({ dispatchedAt: NOW + 11, dispatchedBy: 'user-rfc333' })
      .where(eq(taskQuestions.id, created.questionId))
      .run()
    const module = createTaskExecutionTestModule('daemon-rfc333-manual-ownerless')
    const settled = new ManualQuestionParkTransaction(
      module.ownership,
      composeTaskExecutionHumanGateAdapter(),
      new LegacyHumanGateTaskLifecycle(),
    ).settle({ db, taskId, now: NOW + 20 })
    expect(settled).toEqual({ consumed: 1, parked: false })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get()?.state,
    ).toBe('completed')
  })

  test('an auto-dispatch-deferred question yields its park obligation to the runnable predecessor', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-auto-dispatch-deferred'
    seedTask(db, taskId, 'running')
    const created = createManual(db, taskId)
    // Regression: a mixed-cause "dispatch all" atomically mints the first
    // handler rerun and marks the lower-priority manual question for automatic
    // dispatch. Parking here, before the DAG can run that predecessor, leaves
    // both obligations waiting on each other forever.
    db.update(taskQuestions)
      .set({ autoDispatchDeferredAt: NOW + 11 })
      .where(eq(taskQuestions.id, created.questionId))
      .run()
    const module = createTaskExecutionTestModule('daemon-rfc333-manual-auto-deferred')
    const settled = new ManualQuestionParkTransaction(
      module.ownership,
      composeTaskExecutionHumanGateAdapter(),
      new LegacyHumanGateTaskLifecycle(),
    ).settle({ db, taskId, now: NOW + 20 })

    expect(settled).toEqual({ consumed: 1, parked: false })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get()?.state,
    ).toBe('completed')
  })

  test('awaiting-human obligation survives release until a later owner settle', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-revision-rebase'
    seedTask(db, taskId, 'awaiting_human')
    const created = createManual(db, taskId)
    db.update(tasks)
      .set({ status: 'running', lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 3` })
      .where(eq(tasks.id, taskId))
      .run()
    const module = createTaskExecutionTestModule('daemon-rfc333-manual-rebase')
    const settled = new ManualQuestionParkTransaction(
      module.ownership,
      composeTaskExecutionHumanGateAdapter(),
      new LegacyHumanGateTaskLifecycle(),
    ).settle({ db, taskId, now: NOW + 30 })
    expect(settled).toEqual({ consumed: 1, parked: true })
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 5,
    })
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get()?.state,
    ).toBe('completed')
  })

  test('final done CAS rolls back when a question lands before its in-tx settle check', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-manual-done-fence'
    seedTask(db, taskId, 'running')
    createManual(db, taskId)
    let caught: unknown = null
    try {
      await trySetTaskStatus({
        db,
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        reason: 'rfc333-manual-done-fence',
        onTransitionTx: (tx) =>
          assertNoManualQuestionParkObligationTx(
            tx,
            taskId,
            composeTaskExecutionHumanGateAdapter(),
          ),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ManualQuestionParkRequired)
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('running')
  })
})

describe('RFC-333 T5 TaskDecisionParticipantInTx', () => {
  test('commits task event + exactly one intent + linked rollback effect', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-decision'
    seedTask(db, taskId, 'awaiting_review')
    const ids = seedDecisionNodes(db, taskId)
    const module = createTaskExecutionTestModule('daemon-rfc333-decision')
    const receipt = dbTxSync(db, (tx) => submitDecision(tx, { taskId, ...ids, module }))

    expect(receipt.taskRevision).toBe(2)
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
      status: 'pending',
      lifecycleEventRevision: 2,
    })
    const intents = db
      .select()
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.taskId, taskId))
      .all()
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      id: receipt.continuationRef,
      kind: 'gate-continuation',
      state: 'pending',
      expectedTaskRevision: 2,
    })
    expect(JSON.parse(intents[0]!.payloadJson)).toMatchObject({
      v: 1,
      operationId: `operation:${taskId}`,
      workspaceRollbackPlan: { planDigest: 'b'.repeat(64) },
    })
    expect(db.select().from(taskExecutionEffects).all()).toEqual([
      expect.objectContaining({
        taskId,
        currentIntentId: receipt.continuationRef,
        kind: 'workspace-rollback',
        state: 'open',
        requestHash: 'b'.repeat(64),
        lastAttemptNo: 0,
      }),
    ])
    expect(
      db
        .select()
        .from(committedEvents)
        .where(eq(committedEvents.id, `task-lifecycle:${taskId}:2`))
        .get(),
    ).toMatchObject({ aggregateId: taskId, eventType: 'task.lifecycle-transitioned.v1' })

    expect(() => dbTxSync(db, (tx) => submitDecision(tx, { taskId, ...ids, module }))).toThrow()
    expect(db.select().from(taskExecutionIntents).all()).toHaveLength(1)
  })

  test('admits one gate successor behind a claimed owner while every other admission stays exclusive', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-decision-handoff'
    seedTask(db, taskId, 'awaiting_review')
    const ids = seedDecisionNodes(db, taskId)
    const module = createTaskExecutionTestModule('daemon-rfc333-decision-handoff')
    const launch = module.intents.submit({
      db,
      intentId: 'intent-rfc333-handoff-owner',
      request: {
        taskId,
        kind: 'launch',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: slotPath(taskId),
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
      now: NOW,
    })
    const claimed = module.claim({ db, intentId: launch.intentId, now: NOW + 1 })
    module.claimGate.leave(claimed.permit)

    expect(() =>
      module.intents.submit({
        db,
        intentId: 'intent-rfc333-exclusive-conflict',
        request: {
          taskId,
          kind: 'resume',
          source: 'internal',
          actorUserId: null,
          expectedTaskRevision: 1,
          scope: {
            executionLineageId: taskId,
            continuationSlotKey: `${taskId}:root`,
            slotPath: slotPath(taskId),
            operationGeneration: 0,
          },
          payload: { v: 1, reason: 'must-stay-exclusive' },
        },
        now: NOW + 2,
      }),
    ).toThrow(expect.objectContaining({ code: 'task-continuation-conflict' }))

    const decision = dbTxSync(db, (tx) => submitDecision(tx, { taskId, ...ids, module }))
    const active = db
      .select({ id: taskExecutionIntents.id, state: taskExecutionIntents.state })
      .from(taskExecutionIntents)
      .where(inArray(taskExecutionIntents.state, ['pending', 'claimed']))
      .all()
    expect(active).toHaveLength(2)
    expect(active).toEqual(
      expect.arrayContaining([
        { id: launch.intentId, state: 'claimed' },
        { id: decision.continuationRef, state: 'pending' },
      ]),
    )

    expect(() =>
      module.intents.submit({
        db,
        intentId: 'intent-rfc333-second-successor',
        admissionMode: 'successor-after-claimed',
        request: {
          taskId,
          kind: 'gate-continuation',
          source: 'internal',
          actorUserId: null,
          expectedTaskRevision: decision.taskRevision,
          scope: {
            executionLineageId: taskId,
            continuationSlotKey: `${taskId}:root`,
            slotPath: slotPath(taskId),
            operationGeneration: 0,
          },
          payload: { v: 1, operationId: 'second-gate-successor' },
        },
        now: NOW + 3,
      }),
    ).toThrow(expect.objectContaining({ code: 'task-continuation-conflict' }))
  })

  test('projection, lifecycle-event, and intent faults each roll prior domain writes back', () => {
    for (const fault of ['projection', 'event', 'intent'] as const) {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `task-333-${fault}-fault`
      seedTask(db, taskId, 'awaiting_review')
      const ids = seedDecisionNodes(db, taskId)
      const module = createTaskExecutionTestModule(`daemon-rfc333-${fault}`)
      const oldFence = projectionFence(db, [ids.sourceNodeRunId, ids.rerunNodeRunId])
      if (fault === 'event') {
        db.run(sql`
          CREATE TRIGGER rfc333_fail_lifecycle_event
          BEFORE INSERT ON committed_events
          BEGIN SELECT RAISE(ABORT, 'rfc333-event-fault'); END
        `)
      }
      if (fault === 'intent') {
        db.run(sql`
          CREATE TRIGGER rfc333_fail_continuation_intent
          BEFORE INSERT ON task_execution_intents
          BEGIN SELECT RAISE(ABORT, 'rfc333-intent-fault'); END
        `)
      }

      expect(() =>
        dbTxSync(db, (tx) => {
          tx.update(nodeRuns)
            .set({ reviewIteration: 1 })
            .where(eq(nodeRuns.id, ids.sourceNodeRunId))
            .run()
          const fence =
            fault === 'projection'
              ? oldFence
              : projectionFence(tx, [ids.sourceNodeRunId, ids.rerunNodeRunId])
          return submitDecision(tx, {
            taskId,
            ...ids,
            module,
            expectedFence: fence,
            rollback: false,
          })
        }),
      ).toThrow()

      expect(
        db.select().from(nodeRuns).where(eq(nodeRuns.id, ids.sourceNodeRunId)).get()
          ?.reviewIteration,
      ).toBe(0)
      expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()).toMatchObject({
        status: 'awaiting_review',
        lifecycleEventRevision: 1,
      })
      expect(db.select().from(taskExecutionIntents).all()).toHaveLength(0)
      expect(db.select().from(committedEvents).all()).toHaveLength(0)
    }
  })

  test('pre-drive settles the linked effect and projection exactly once before rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-pre-drive'
    seedTask(db, taskId, 'awaiting_review')
    const ids = seedDecisionNodes(db, taskId)
    const module = createTaskExecutionTestModule('daemon-rfc333-pre-drive')
    const decision = dbTxSync(db, (tx) => submitDecision(tx, { taskId, ...ids, module }))
    const claimed = module.claim({ db, intentId: decision.continuationRef, now: NOW + 1 })
    module.claimGate.leave(claimed.permit)
    const events: string[] = []
    const executor: GateWorkspaceRollbackExecutor = {
      async loadValidatedPlan(ref) {
        events.push(`load:${ref.operationId}`)
        return { ...ref, resourceKeys: [`workspace:${taskId}`] }
      },
      async executeValidatedPlan(plan) {
        events.push(`act:${plan.operationId}`)
        return {
          rolledBack: true,
          applicationEvidence: 'applied',
          receipt: {
            targetCount: 1,
            failureCount: 0,
            successfulSourceNodeRunIds: [ids.sourceNodeRunId],
            targets: [
              {
                sourceNodeRunId: ids.sourceNodeRunId,
                worktreeDirName: 'repo',
                snapshot: 'snapshot-1',
                ok: true,
              },
            ],
          },
        }
      },
    }
    const step = new GateContinuationEffectStep(db, module.effects, executor)
    const execution = createTaskExecutionContext({
      intentId: decision.continuationRef,
      token: claimed.token,
      db,
    })
    const context = {
      taskId,
      execution,
      signal: new AbortController().signal,
      runtime: resolveTaskDriveConfig({ appHome: '/tmp/rfc333-pre-drive' }),
    }

    await expect(step.run(context)).resolves.toEqual({ kind: 'ready' })
    await expect(step.run(context)).resolves.toEqual({ kind: 'ready' })
    expect(events).toEqual([`load:operation:${taskId}`, `act:operation:${taskId}`])
    expect(db.select().from(taskExecutionEffects).get()).toMatchObject({
      state: 'succeeded',
      lastAttemptNo: 1,
    })
    expect(db.select().from(taskExecutionEffectAttempts).get()).toMatchObject({
      state: 'succeeded',
      applicationEvidence: 'applied',
    })
    expect(
      db.select().from(nodeRuns).where(eq(nodeRuns.id, ids.sourceNodeRunId)).get()?.rolledBack,
    ).toBe(true)
  })

  test('pre-drive preserves the exact legacy task-gate resume variant without weakening RFC-333 payloads', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-333-legacy-task-gate'
    seedTask(db, taskId, 'pending')
    const module = createTaskExecutionTestModule('daemon-rfc333-legacy-task-gate')
    const submitted = module.intents.submit({
      db,
      intentId: 'intent-rfc333-legacy-task-gate',
      request: {
        taskId,
        kind: 'gate-continuation',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: slotPath(taskId),
          operationGeneration: 0,
        },
        payload: { v: 1, event: 'resume' },
      },
      now: NOW,
    })
    const claimed = module.claim({ db, intentId: submitted.intentId, now: NOW + 1 })
    module.claimGate.leave(claimed.permit)
    const executor: GateWorkspaceRollbackExecutor = {
      async loadValidatedPlan() {
        throw new Error('legacy task gate must not load a collaboration rollback plan')
      },
      async executeValidatedPlan() {
        throw new Error('legacy task gate must not execute a collaboration rollback plan')
      },
    }
    const step = new GateContinuationEffectStep(db, module.effects, executor)
    const context = {
      taskId,
      execution: createTaskExecutionContext({
        intentId: submitted.intentId,
        token: claimed.token,
        db,
      }),
      signal: new AbortController().signal,
      runtime: resolveTaskDriveConfig({ appHome: '/tmp/rfc333-legacy-task-gate' }),
    }

    await expect(step.run(context)).resolves.toEqual({ kind: 'ready' })

    db.update(taskExecutionIntents)
      .set({ payloadJson: '{"event":"resume","extra":true,"v":1}' })
      .where(eq(taskExecutionIntents.id, submitted.intentId))
      .run()
    await expect(step.run(context)).rejects.toThrow('invalid-human-gate-continuation-payload')
  })
})
