// RFC-074 (was RFC-056 patch 2026-05-22 "Layer A sibling cascade").
//
// HISTORY: RFC-056 made `triggerDesignerRerun` eagerly mint a fresh pending
// node_run for EVERY downstream node on a cross-clarify designer rerun, because
// the scheduler's cci-based freshness couldn't propagate a rerun lazily and
// downstream rows stayed `done` against stale upstream output.
//
// RFC-074 (PR-B, T-B8) REMOVES that eager cascade. Downstream propagation is now
// lazy + provenance-driven: `triggerDesignerRerun` mints ONLY the designer's
// own rerun row; the scheduler's per-batch `recomputeFreshnessAndDemote` demotes
// a downstream node once the designer's rerun actually produces a fresher done
// row (the node consumed the OLD designer run → stale → re-dispatched). The
// eager pre-mint was exactly the speculative over-trigger the RFC eliminates.
//
// These tests therefore now LOCK THE ABSENCE of the cascade: after
// `submitCrossClarifyAnswers` directive=continue, the designer gets a rerun row
// but downstream nodes (rev1, questioner, …) keep their existing rows untouched.
//
//   in → designer → rev1 → questioner → rev2 → out
//                                  ↘  cross_clarify (clarify-channel; SKIP)
//
// End-to-end downstream re-run after a cross-clarify is covered by the
// combination scenarios (S13/S15) running the real scheduler.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

function cascadeDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'rev1', kind: 'review', sourceNodeId: 'designer', sourcePortName: 'docpath' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'rev2', kind: 'review', sourceNodeId: 'questioner', sourcePortName: 'docpath' },
      { id: 'out', kind: 'output', ports: [] },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_r1',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'rev1', portName: 'src' },
      },
      {
        id: 'e_r1_q',
        source: { nodeId: 'rev1', portName: 'approved_doc' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
      {
        id: 'e_q_r2',
        source: { nodeId: 'questioner', portName: 'docpath' },
        target: { nodeId: 'rev2', portName: 'src' },
      },
      {
        id: 'e_r2_out',
        source: { nodeId: 'rev2', portName: 'approved_doc' },
        target: { nodeId: 'out', portName: 'final' },
      },
      // cross-clarify channel — questioner asks designer
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = cascadeDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'cascade',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cascade',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedDoneRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...fields,
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-074 — designer rerun no longer eagerly cascades downstream', () => {
  test('submit mints ONLY the designer rerun; downstream nodes are NOT pre-cascaded', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Seed a done designer + done downstream chain mirroring the
    // production failure shape.
    await seedDoneRun(db, taskId, 'in')
    await seedDoneRun(db, taskId, 'designer', { preSnapshot: 'snap-a' })
    await seedDoneRun(db, taskId, 'rev1')
    const qRun = await seedDoneRun(db, taskId, 'questioner')
    // rev2 / out haven't run yet — exercise the "node never ran" branch.

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })

    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')

    // Designer's new pending row carries clarifyIteration=1.
    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    expect(designerRows.length).toBe(2)
    const designerFresh = designerRows.find((r) => r.status === 'pending')
    // RFC-074 PR-C: the designer rerun is a fresh pending insert (latest id wins).
    expect(designerFresh).toBeDefined()

    // RFC-074 NO-CASCADE LOCK: rev1 + questioner are NOT pre-minted a pending
    // row. Each keeps exactly its single done row from iteration 0; the
    // scheduler will demote + re-dispatch them lazily once the designer rerun
    // produces a fresher done row (provenance freshness, recomputeFreshnessAndDemote).
    for (const nodeId of ['rev1', 'questioner']) {
      const rows = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      expect(rows.length, `${nodeId} should NOT be pre-cascaded (single done row)`).toBe(1)
      expect(rows[0]?.status).toBe('done')
    }

    // Nodes that NEVER ran (rev2, out) have no rows either way.
    for (const nodeId of ['rev2', 'out']) {
      const rows = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      expect(rows.length, `${nodeId} should have NO rows (never ran)`).toBe(0)
    }

    // STRICT downstream only: the upstream `in` node is NOT cascaded.
    const inRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'in')))
    expect(inRows.length, 'in should have its single done row only — not cascaded').toBe(1)
    expect(inRows[0]?.status).toBe('done')
  })

  test('submit does not pre-mint a downstream rev1 row (no cascade to be idempotent about)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDoneRun(db, taskId, 'designer')
    await seedDoneRun(db, taskId, 'rev1')
    const qRun = await seedDoneRun(db, taskId, 'questioner')

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const rev1Count = (
      await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'rev1')))
    ).length
    // RFC-074: no cascade row is minted on rev1 — it keeps its single done row.
    // (The designer rerun row is the only thing submit mints; downstream
    // re-runs are driven lazily by the scheduler's freshness recompute.)
    expect(rev1Count).toBe(1)
  })

  test('clarify-channel edges are skipped — cascade does NOT mint a pending row on the cross-clarify node itself', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDoneRun(db, taskId, 'designer')
    const qRun = await seedDoneRun(db, taskId, 'questioner')

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    // The cross-clarify node itself is reachable from designer ONLY via
    // a clarify-channel edge (to_designer → __external_feedback__), so
    // the BFS skips it. The cross-clarify node_run minted by
    // createCrossClarifySession is the only row, and it transitioned
    // pending → awaiting_human → answered via submit.
    const crossRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'cross1')))
    expect(crossRows.length, 'cross-clarify node should NOT receive a cascade-minted row').toBe(1)
  })

  test('a downstream rev1 with rich clarify/retry history is left untouched (no cascade overwrite)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDoneRun(db, taskId, 'designer')
    // rev1 had been through 3 self-clarify rounds + 2 retries by the time
    // cross-clarify fired — the cascade must not destroy this history.
    await seedDoneRun(db, taskId, 'rev1', {
      retryIndex: 2,
      preSnapshot: 'snap-r1-final',
    })
    const qRun = await seedDoneRun(db, taskId, 'questioner', {
      preSnapshot: 'snap-q-final',
    })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const rev1Rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'rev1')))
    // RFC-074: no cascade row is minted, so rev1's hard-won history (cci=3,
    // retry=2, preSnapshot) is left exactly as-is — there is no append-only
    // pending row to validate. The designer rerun + lazy freshness will
    // re-dispatch rev1 later (recording fresh consumed) without destroying this.
    expect(rev1Rows.length, 'rev1 keeps its single done row').toBe(1)
    expect(rev1Rows[0]?.status).toBe('done')
    expect(rev1Rows[0]?.preSnapshot).toBe('snap-r1-final')
    expect(rev1Rows[0]?.retryIndex).toBe(2)
  })
})
