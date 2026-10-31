import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { nodeRunFixtureColumns } from './helpers/model/nodeRun'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { withO2Closure } from './helpers/o2Closure'
import {
  composeHumanGateTaskLockPort,
  createTaskExecutionTestModule,
} from '@/modules/task-execution/composition'
// RFC-333 TaskParkTx — sibling human gates of one scheduler wave all park.
//
// WHY THIS FILE EXISTS (regression intent):
//   Two parallel agents that both ask back must both reach their clarify gate.
//   The e2e-full nightly lost one of them: `centralized-answer-pane.spec.ts`
//   waited for 2 awaiting rounds and saw 1 on both attempts (run 38681082449,
//   a5ae4b5b7), and `cross-clarify-multi-source.spec.ts` flaked with the same
//   "expected 2, received 1" (runs 38263207107, 38406332608).
//
//   Cause: a gate open binds its prepared operation to the task lifecycle
//   revision it read before preparing. When the asking siblings finish in the
//   same wave, the first TaskParkTx moves the task running→awaiting_human and
//   bumps that revision; the second park then failed with
//   `human-gate revision changed`, its asking node threw out of the scope, and
//   the question was never shown to anyone.
//
//   Contract locked here: a park made by the task's running owner is fenced by
//   the owner token (ownerId + daemon generation + epoch, claimed), which is the
//   execution generation. Such a park applies to the task as it is now — it
//   joins a task its sibling already parked, re-parks a task a decision moved
//   back to running, and is still refused for a task that left the running
//   lifecycle. A park without an owner keeps the exact prepared revision as its
//   only fence (locked by rfc359-w4-d25-adapters.test.ts).

import {
  nodeRunFixture,
  patchTaskFixture,
  taskFixture,
  workflowFixture,
  readTaskFixtures,
} from './helpers/model'

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ClarifyGateOpenPreparation } from '@/modules/collaboration/application/prepareClarifyGateOpen'
import { DatabaseClarifyQuestionSnapshotReader } from '@/modules/collaboration/infrastructure/clarifyQuestionSnapshotReader'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'

import { createTaskExecutionContext } from '@/modules/task-execution/composition/sqliteTaskExecutionContext'
import { createTaskRuntimeLifecyclePersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  encodeLineageSlotPath,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { DatabaseHumanGateTaskLifecyclePersistence } from '@/modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createClarifyRound } from '../src/services/clarify/service'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_969_900_000

function slotPath(taskId: string): readonly LineageSlot[] {
  return [{ stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 }]
}

/** Two independent designers, each with its own clarify gate (the e2e fixture's shape). */
function siblingAskersDefinition(): WorkflowDefinition {
  const pair = (side: 'a' | 'b') => ({
    nodes: [
      { id: `designer_${side}`, kind: 'agent-single' as const, agentName: `designer_${side}` },
      { id: `clarify_${side}`, kind: 'clarify' as const },
    ],
    edges: [
      {
        id: `e_in_${side}`,
        source: { nodeId: 'in', portName: 'topic' },
        target: { nodeId: `designer_${side}`, portName: 'topic' },
      },
      {
        id: `e_ask_${side}`,
        source: { nodeId: `designer_${side}`, portName: '__clarify__' },
        target: { nodeId: `clarify_${side}`, portName: 'questions' },
      },
      {
        id: `e_ans_${side}`,
        source: { nodeId: `clarify_${side}`, portName: 'answers' },
        target: { nodeId: `designer_${side}`, portName: '__clarify_response__' },
      },
    ],
  })
  const a = pair('a')
  const b = pair('b')
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
    nodes: [{ id: 'in', kind: 'input' }, ...a.nodes, ...b.nodes],
    edges: [...a.edges, ...b.edges],
    outputs: [],
  }
}

function question(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}?`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Yes', description: '', recommended: false, recommendationReason: '' },
      { label: 'No', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

/** A running task whose two designers both finished with a question, owned by a claimed driver. */
async function seedOwnedSiblingAskers(db: PersistenceDb, taskId: string) {
  const definition = siblingAskersDefinition()
  const workflowId = `wf-${taskId}`
  await workflowFixture(db, {
    id: workflowId,
    name: workflowId,
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await taskFixture(db, {
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    workflowVersion: 1,
    repoPath: '/tmp/rfc333-sibling-gates',
    worktreePath: '/tmp/rfc333-sibling-gates',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW - 1_000,
    lifecycleEventRevision: 1,
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath(slotPath(taskId)),
  })
  await nodeRunFixture(
    db,
    (['a', 'b'] as const).map((side) => ({
      id: `${taskId}-designer-${side}`,
      taskId,
      nodeId: `designer_${side}`,
      status: 'done' as const,
      retryIndex: 0,
      iteration: 0,
      startedAt: NOW - 500,
      finishedAt: NOW - 100,
    })),
  )
  const intent = await new DrizzleTaskExecutionIntentPersistence(db).submit({
    intentId: `intent-${taskId}`,
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
  const module = createTaskExecutionTestModule(`daemon-${taskId}`)
  const claimed = await module.claim({ db, intentId: intent.intentId, now: NOW })
  module.claimGate.leave(claimed.permit)
  return {
    token: claimed.token,
    // The scheduler hands gate opens the driver's registered execution context.
    executionContext: createTaskExecutionContext({
      humanGateOpen: composeHumanGateOpenParticipantFactory(),
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      intentId: intent.intentId,
      token: claimed.token,
      db,
    }),
  }
}

/** Prepares one sibling's clarify gate through the production preparation, bound to `revision`. */
async function prepareSiblingGate(
  db: PersistenceDb,
  taskId: string,
  side: 'a' | 'b',
  revision: number,
) {
  const result = await new ClarifyGateOpenPreparation(
    new DatabaseHumanGateOperationPersistence(
      databaseSessionFor(db),
      composeHumanGateTaskLockPort,
      { historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions },
    ),
    new DatabaseClarifyQuestionSnapshotReader(db),
  ).prepare({
    taskId,
    kind: 'self',
    askingNodeId: `designer_${side}`,
    askingNodeRunId: `${taskId}-designer-${side}`,
    askingShardKey: null,
    intermediaryNodeId: `clarify_${side}`,
    targetConsumerNodeId: null,
    parentNodeRunId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([{ id: `q-${side}`, title: `Question ${side}?` }]),
    questions: [{ id: `q-${side}`, title: `Question ${side}?` }],
    truncationWarningsJson: null,
    sourceSnapshotDigest: (side === 'a' ? 'a' : 'b').repeat(64),
    idempotencyKey: `open:${taskId}:${side}`,
    expectedTaskRevision: revision,
    now: NOW + 1,
  })
  if (result.kind !== 'prepared') throw new Error('expected a prepared clarify operation')
  return result
}

function parker(db: PersistenceDb): DatabaseHumanGateTaskLifecyclePersistence {
  return new DatabaseHumanGateTaskLifecyclePersistence(
    db,
    createTaskRuntimeLifecyclePersistence(db),
    {
      humanGateOpen: composeHumanGateOpenParticipantFactory(),
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    },
  )
}

async function taskRow(db: PersistenceDb, taskId: string) {
  return (await readTaskFixtures(db, { id: taskId }, { limit: 1 }))[0]!
}

async function operationState(db: PersistenceDb, operationId: string) {
  const { collaborationGateOperations } = tablesOf(db)
  return (
    await db
      .select({ state: collaborationGateOperations.state })
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, operationId))
      .limit(1)
  )[0]?.state
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describeEachProvider('RFC-333 sibling human gates of one wave', (harness) => {
  test('two designers asking back in the same wave both open their clarify gate', async () => {
    const db = harness.db
    const taskId = 'task-333-sibling-open'
    const { executionContext } = await seedOwnedSiblingAskers(db, taskId)

    const ask = (side: 'a' | 'b') =>
      createClarifyRound(
        withO2Closure({
          kind: 'self',
          db,
          taskId,
          executionContext,
          askingNodeId: `designer_${side}`,
          askingNodeRunId: `${taskId}-designer-${side}`,
          askingShardKey: null,
          intermediaryNodeId: `clarify_${side}`,
          iteration: 0,
          questions: [question(`q-${side}`)],
        }),
      )
    // Both asks start before either parks — exactly what the scheduler does when
    // two in-flight siblings settle in the same tick.
    const opened = await Promise.all([ask('a'), ask('b')])

    const { clarifyRounds, nodeRuns } = tablesOf(db)
    const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    expect(rounds.map((round) => round.intermediaryNodeId).sort()).toEqual([
      'clarify_a',
      'clarify_b',
    ])
    expect(rounds.every((round) => round.status === 'awaiting_human')).toBe(true)
    for (const { intermediaryNodeRunId } of opened) {
      const gate = (
        await db
          .select(nodeRunFixtureColumns(db))
          .from(nodeRuns)
          .where(eq(nodeRuns.id, intermediaryNodeRunId))
          .limit(1)
      )[0]
      expect(gate?.status).toBe('awaiting_human')
    }
    // One lifecycle transition for the wave: the first gate parks, the second joins.
    expect(await taskRow(db, taskId)).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 2,
    })
  })

  test('a gate prepared before its sibling parked joins the parked task', async () => {
    const db = harness.db
    const taskId = 'task-333-sibling-join'
    const { token } = await seedOwnedSiblingAskers(db, taskId)
    const first = await prepareSiblingGate(db, taskId, 'a', 1)
    const second = await prepareSiblingGate(db, taskId, 'b', 1)

    const parkedFirst = await parker(db).parkPrepared({
      prepared: first.prepared,
      token,
      now: NOW + 2,
    })
    expect(parkedFirst.taskRevision).toBe(2)

    const parkedSecond = await parker(db).parkPrepared({
      prepared: second.prepared,
      token,
      now: NOW + 3,
    })
    // Joining changes no task state: same revision, only the gate's own event.
    expect(parkedSecond.taskRevision).toBe(2)
    expect(parkedSecond.eventRefs).toHaveLength(1)
    expect(await operationState(db, second.prepared.operationId)).toBe('completed')
    expect(await taskRow(db, taskId)).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 2,
    })
    const { clarifyRounds } = tablesOf(db)
    expect(
      await db
        .select()
        .from(clarifyRounds)
        .where(
          and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.intermediaryNodeId, 'clarify_b')),
        ),
    ).toHaveLength(1)
  })

  test('a sibling gate re-parks a task that a decision moved back to running', async () => {
    const db = harness.db
    const taskId = 'task-333-sibling-repark'
    const { token } = await seedOwnedSiblingAskers(db, taskId)
    const first = await prepareSiblingGate(db, taskId, 'a', 1)
    const second = await prepareSiblingGate(db, taskId, 'b', 1)
    await parker(db).parkPrepared({ prepared: first.prepared, token, now: NOW + 2 })
    // The first gate was answered while the second asker was still settling:
    // the same owner keeps driving, and the task is running again.
    await patchTaskFixture(db, { id: taskId }, { status: 'running', lifecycleEventRevision: 3 })

    const parked = await parker(db).parkPrepared({
      prepared: second.prepared,
      token,
      now: NOW + 4,
    })

    expect(parked.taskRevision).toBe(4)
    expect(await taskRow(db, taskId)).toMatchObject({
      status: 'awaiting_human',
      lifecycleEventRevision: 4,
    })
    expect(await operationState(db, second.prepared.operationId)).toBe('completed')
  })

  test('a late sibling gate never re-opens a task that left the running lifecycle', async () => {
    const db = harness.db
    const taskId = 'task-333-sibling-terminal'
    const { token } = await seedOwnedSiblingAskers(db, taskId)
    const first = await prepareSiblingGate(db, taskId, 'a', 1)
    const second = await prepareSiblingGate(db, taskId, 'b', 1)
    await parker(db).parkPrepared({ prepared: first.prepared, token, now: NOW + 2 })
    const { clarifyRounds } = tablesOf(db)
    await patchTaskFixture(
      db,
      { id: taskId },
      {
        status: 'canceled',
        lifecycleEventRevision: 3,
      },
    )

    await expect(
      parker(db).parkPrepared({ prepared: second.prepared, token, now: NOW + 4 }),
    ).rejects.toMatchObject({ code: 'illegal-task-transition' })

    // The whole park rolled back: the task stays canceled and the gate never opened.
    expect(await taskRow(db, taskId)).toMatchObject({
      status: 'canceled',
      lifecycleEventRevision: 3,
    })
    expect(await operationState(db, second.prepared.operationId)).toBe('prepared')
    expect(
      await db
        .select()
        .from(clarifyRounds)
        .where(
          and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.intermediaryNodeId, 'clarify_b')),
        ),
    ).toHaveLength(0)
  })
})
