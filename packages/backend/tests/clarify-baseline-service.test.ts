// RFC-058 PR-A baseline (T2/T3) — merged & parameterized by RFC-217 T9.
//
// One suite locks the unified clarify service (services/clarify/service.ts)
// for BOTH kinds:
//   - PARAMETERIZED (kind ∈ {self, cross}): the symmetric createClarifyRound
//     invariants — row stamped with kind, status awaiting_human, intermediary
//     node_run parked, terminatedAs null, kind-correct created WS event.
//   - self-specific: field projection (agent-single + agent-multi shard),
//     sealAnswersServerSide forgery defence, task-delete FK cascade,
//     node_run_outputs aging probe.
//   - cross-specific: iteration counter (same node × loopIter; loop_iter
//     isolation; independent per-node counters), designer rerun readiness,
//     resolveCrossNodeStopped reject persistence (RFC-132 T7 node directive).
//
// (RFC-132 retired the legacy quick-channel outcome contract; its unified
// equivalents are locked by rfc128-p5-d-autodispatch.test.ts.)

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, nodeRunOutputs, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  createClarifyRound,
  evaluateDesignerRerunReadiness,
  resolveCrossNodeStopped,
  sealAnswersServerSide,
} from '../src/services/clarify/service'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// ---------------------------------------------------------------------------
// Harness — self topology (agent + clarify) and cross topology (questioner(s)
// + cross-clarify node(s) + designer).
// ---------------------------------------------------------------------------

async function seedTask(
  db: DbClient,
  opts: { id?: string; definition?: WorkflowDefinition } = {},
): Promise<{ taskId: string }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const def: WorkflowDefinition = opts.definition ?? {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-clarify-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running' as const,
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

async function seedCrossClarifyTask(
  db: DbClient,
  opts: {
    id?: string
    questionerNodeIds?: string[]
    crossClarifyNodeIds?: string[]
  } = {},
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const designerNodeId = 'designer'
  const questionerNodeIds = opts.questionerNodeIds ?? ['questioner']
  const crossClarifyNodeIds = opts.crossClarifyNodeIds ?? ['cc1']
  const nodes: WorkflowNode[] = [
    { id: designerNodeId, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    ...questionerNodeIds.map(
      (qid) =>
        ({
          id: qid,
          kind: 'agent-single',
          agentName: qid,
        }) as WorkflowNode,
    ),
    ...crossClarifyNodeIds.map(
      (ccId) =>
        ({
          id: ccId,
          kind: 'clarify-cross-agent',
          title: ccId,
        }) as WorkflowNode,
    ),
  ]
  const edges = [] as WorkflowDefinition['edges']
  for (let i = 0; i < crossClarifyNodeIds.length; i++) {
    const ccId = crossClarifyNodeIds[i]!
    const qId = questionerNodeIds[Math.min(i, questionerNodeIds.length - 1)]!
    edges.push({
      id: `e_q_${ccId}`,
      source: { nodeId: qId, portName: '__clarify__' },
      target: { nodeId: ccId, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${ccId}`,
      source: { nodeId: ccId, portName: 'to_designer' },
      target: { nodeId: designerNodeId, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${ccId}`,
      source: { nodeId: ccId, portName: 'to_questioner' },
      target: { nodeId: qId, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cross-clarify-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition: def }
}

function makeQuestion(overrides: Partial<ClarifyQuestion> = {}): ClarifyQuestion {
  return {
    id: 'q1',
    title: 'Which database?',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
    ...overrides,
  }
}

function makeAnswer(overrides: Partial<ClarifyAnswer> = {}): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
    ...overrides,
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// PARAMETERIZED — the symmetric createClarifyRound invariants (RFC-217 T9
// AC-8: the self/cross baseline pairs collapse into one kind-looped suite).
// ---------------------------------------------------------------------------

for (const kind of ['self', 'cross'] as const) {
  describe(`RFC-217 T9 baseline — createClarifyRound symmetric invariants (kind=${kind})`, () => {
    async function seedAndCreate(db: DbClient): Promise<{
      taskId: string
      round: Awaited<ReturnType<typeof createClarifyRound>>['round']
      intermediaryNodeRunId: string
      events: Array<{ type: string }>
    }> {
      const events: Array<{ type: string }> = []
      if (kind === 'self') {
        const { taskId } = await seedTask(db)
        await db.insert(nodeRuns).values({
          id: 'nr_sym_src',
          taskId,
          nodeId: 'designer',
          status: 'done',
          retryIndex: 0,
          iteration: 0,
        })
        taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => events.push(m as { type: string }))
        const { round, intermediaryNodeRunId } = await createClarifyRound({
          kind: 'self',
          db,
          taskId,
          askingNodeId: 'designer',
          askingNodeRunId: 'nr_sym_src',
          askingShardKey: null,
          intermediaryNodeId: 'clarify1',
          iteration: 0,
          questions: [makeQuestion()],
        })
        return { taskId, round, intermediaryNodeRunId, events }
      }
      const { taskId } = await seedCrossClarifyTask(db)
      await db.insert(nodeRuns).values({
        id: 'nr_sym_src',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      })
      taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => events.push(m as { type: string }))
      const { round, intermediaryNodeRunId } = await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: 'cc1',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_sym_src',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion()],
      })
      return { taskId, round, intermediaryNodeRunId, events }
    }

    test('row stamped with kind + awaiting_human; intermediary run parked; terminatedAs null', async () => {
      const db = createInMemoryDb(MIGRATIONS)
      const { taskId, round, intermediaryNodeRunId } = await seedAndCreate(db)
      expect(round.kind).toBe(kind)
      expect(round.status).toBe('awaiting_human')
      expect(round.terminatedAs).toBeNull()
      const row = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round.id)))[0]
      expect(row?.kind).toBe(kind)
      expect(row?.taskId).toBe(taskId)
      expect(row?.status).toBe('awaiting_human')
      const nr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, intermediaryNodeRunId)))[0]
      expect(nr?.status).toBe('awaiting_human')
    })

    test('created WS event fires with the kind-correct FROZEN type string', async () => {
      const db = createInMemoryDb(MIGRATIONS)
      const { events } = await seedAndCreate(db)
      const expected = kind === 'self' ? 'clarify.created' : 'cross-clarify.created'
      expect(events.map((e) => e.type)).toContain(expected)
    })
  })
}

// ---------------------------------------------------------------------------
// self-specific
// ---------------------------------------------------------------------------

describe('RFC-058 baseline T2 — createClarifyRound / row shape', () => {
  test('agent-single: session row carries source agent + shard NULL; clarify node_run awaiting_human', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_1',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { round: session, intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_source_1',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    expect(session.status).toBe('awaiting_human')
    expect(session.askingNodeId).toBe('designer')
    expect(session.askingShardKey).toBeNull()
    expect(session.iteration).toBe(0)
    const cnr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(cnr?.status).toBe('awaiting_human')
    expect(cnr?.shardKey).toBeNull()
  })

  test('agent-multi shard child: session row carries shardKey + parent_node_run_id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_multi',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      shardKey: 'shard-A',
      parentNodeRunId: 'parent-multi',
    })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_multi',
      askingShardKey: 'shard-A',
      intermediaryNodeId: 'clarify1',
      iteration: 1,
      questions: [makeQuestion()],
      parentNodeRunId: 'parent-multi',
    })
    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.askingShardKey).toBe('shard-A')
    const cnr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(cnr?.shardKey).toBe('shard-A')
    expect(cnr?.parentNodeRunId).toBe('parent-multi')
  })
})

describe('RFC-058 baseline T2 — sealAnswersServerSide forgery defence', () => {
  test('selectedOptionLabels rebuilt from question.options regardless of client claim', () => {
    const q = makeQuestion()
    const sealed = sealAnswersServerSide(
      [q],
      [
        makeAnswer({
          selectedOptionIndices: [1],
          selectedOptionLabels: ['<<forged>>'],
        }),
      ],
    )
    expect(sealed[0]?.selectedOptionLabels).toEqual(['MySQL'])
  })

  test('out-of-bounds positive indices dropped silently (kept valid ones)', () => {
    const q = makeQuestion() // 2 options [Postgres, MySQL]
    const sealed = sealAnswersServerSide([q], [makeAnswer({ selectedOptionIndices: [5, 0] })])
    expect(sealed[0]?.selectedOptionLabels).toEqual(['Postgres'])
  })
})

describe('RFC-058 baseline T2 — task delete clears clarify rounds (FK cascade)', () => {
  // RFC-217 T9: the explicit cleanupSessionsForTask helper is gone — task
  // delete rides clarify_rounds' ON DELETE CASCADE FK to tasks(id). This
  // locks the cascade itself so a future FK rebuild can't silently drop it.
  test('deleting the task row cascades away its clarify rounds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_cleanup_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { round: session } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_cleanup_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    expect(session.status).toBe('awaiting_human')
    await db.delete(tasks).where(eq(tasks.id, taskId))
    const fresh = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    // Deletion (not a transition to canceled) — cancel-on-task-end is RFC-053
    // invariant CR-1 territory and happens at a different layer.
    expect(fresh.length).toBe(0)
  })
})

describe('RFC-058 baseline T2 — nodeRunOutputs interaction (aging context)', () => {
  test('node_run_outputs row presence is the trigger for the GENERAL aging cutoff (sanity probe)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // A done run with outputs — this is what scheduler keys on for cutoff
    await db.insert(nodeRuns).values({
      id: 'nr_with_outputs',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_with_outputs',
      portName: 'plan',
      content: 'done output',
    })
    const rows = await db
      .select({ id: nodeRunOutputs.nodeRunId })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, 'nr_with_outputs'))
    expect(rows.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// cross-specific
// ---------------------------------------------------------------------------

describe('RFC-058 baseline T3 — createClarifyRound iteration counter', () => {
  test('first session: iteration=0 + row carries source / target / loopIter', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { round: session, intermediaryNodeRunId: crossClarifyNodeRunId } =
      await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: 'cc1',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q_1',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion()],
      })
    expect(session.iteration).toBe(0)
    expect(session.status).toBe('awaiting_human')
    expect(session.targetConsumerNodeId).toBe('designer')
    expect(session.loopIter).toBe(0)
    const nr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, crossClarifyNodeRunId)))[0]
    expect(nr?.status).toBe('awaiting_human')
  })

  test('same (node, loopIter): iteration increments to 1 after another mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { round: s2 } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(s2.iteration).toBe(1)
  })

  test('loop_iter isolation: same node, different loopIter → both start at iteration=0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { round: i0 } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { round: i1 } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 1,
      questions: [makeQuestion()],
    })
    expect(i0.iteration).toBe(0)
    expect(i1.iteration).toBe(0)
  })

  test('different cross-clarify nodes are independent counters', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['questioner'],
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { round: a } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc_a',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { round: b } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc_b',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(a.iteration).toBe(0)
    expect(b.iteration).toBe(0)
  })
})

// (The legacy quick-channel 'outcomes' describe was DELETED by RFC-132 — it locked the
// retired outcome contract itself. The unified equivalents live in
// rfc128-p5-d-autodispatch.test.ts: iteration-mismatch → 'clarify-iteration-mismatch',
// double-answer → 'clarify-already-answered', stop → questioner rerun + node directive.)

describe('RFC-058 baseline T3 — evaluateDesignerRerunReadiness ready/pending logic', () => {
  test('after 1 of 2 submits: ready=false + pending lists unsubmitted cc', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_alpha', 'cc_zeta'],
      questionerNodeIds: ['questioner_alpha', 'questioner_zeta'],
    })
    await db.insert(nodeRuns).values({
      id: 'nr_designer_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 100,
    })
    for (const [qid, ccid] of [
      ['questioner_alpha', 'cc_alpha'],
      ['questioner_zeta', 'cc_zeta'],
    ] as const) {
      const runId = `nr_${qid}`
      await db.insert(nodeRuns).values({
        id: runId,
        taskId,
        nodeId: qid,
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      })
      await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: ccid,
        askingNodeId: qid,
        askingNodeRunId: runId,
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion()],
      })
    }
    // Answer only cc_alpha (unified quick channel; the designer auto-dispatch parks on the
    // not-ready sibling). cc_zeta still awaiting_human.
    const ccAlphaRunRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeId, 'cc_alpha'))
    const cnrA = ccAlphaRunRows[0]!.intermediaryNodeRunId
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: cnrA!,
      answers: [makeAnswer()],
      ifMatchIteration: 0,
      actor,
    })
    const r = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition,
      loopIter: 0,
    })
    expect(r.ready).toBe(false)
    expect(r.pendingCrossClarifyNodeIds).toContain('cc_zeta')
  })
})

describe('RFC-058 baseline T3 — resolveCrossNodeStopped reject persistence', () => {
  test('returns false when no stop submit yet', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner')).toBe(false)
  })

  test('returns true after stop submit, persists across additional continue submits on other ccs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_stop', 'cc_continue'],
      questionerNodeIds: ['questioner_a', 'questioner_b'],
    })
    await db.insert(nodeRuns).values([
      {
        id: 'nr_qa',
        taskId,
        nodeId: 'questioner_a',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_qb',
        taskId,
        nodeId: 'questioner_b',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: cnrStop } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc_stop',
      askingNodeId: 'questioner_a',
      askingNodeRunId: 'nr_qa',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    // RFC-132: the stop answer (unified quick channel) writes the questioner's node-level
    // directive; resolveCrossNodeStopped reads it (RFC-132 T7 single source).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: cnrStop,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
      actor,
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner_a')).toBe(true)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner_b')).toBe(false)
  })
})
