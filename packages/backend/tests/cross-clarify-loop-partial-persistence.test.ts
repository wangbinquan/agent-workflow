// RFC-056 PR-D C5 — wrapper-loop partial persistence 守门.
//
// Inside a wrapper-loop, RFC-056 has TWO semantically-different rules that
// must hold simultaneously per iteration boundary:
//
//   * `directive='stop'` (Reject) on cross-clarify persists ACROSS loop
//     iterations: once rejected, the questioner never produces another
//     awaiting_human row for that node id in this task — even in the next
//     loop iteration.
//   * Q&A history (continue submissions) + `clarify_iteration`
//     counters are PER-loop-iter — they reset when the loop steps to a
//     new iteration so the body re-runs from a clean slate.
//
// This dual semantic is the trickiest contract in RFC-056; it can drift
// in either direction silently (full-reset = rejected user gets pestered
// again; full-persistence = continue-Q&A bleeds into next iter prompt).
//
// LOCKS:
//   1. Iter 0 reject on cross1 → `hasPersistentStop(task, cross1)` is true.
//   2. After iter 0 → iter 1 transition, `hasPersistentStop` STILL true
//      (queried at iter 1).
//   3. Iter 1 `evaluateDesignerRerunReadiness({loopIter: 1})` does NOT see
//      iter 0's continue submissions as ready feedback for iter 1.
//   4. Iter 1 dispatchCrossClarifyNode on a fresh iter-1 node_run for
//      cross1 short-circuits to done (no new awaiting session, no UI
//      pestering of the user in iter 1).
//   5. Iter 0's session row remains queryable (directive='stop',
//      loopIter=0, iteration=0) — persistence is achieved by retention,
//      not by carrying state forward.
//
// If any of these go red the wrapper-loop reject persistence vs Q&A
// reset contract is broken — investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createCrossClarifySession,
  dispatchCrossClarifyNode,
  evaluateDesignerRerunReadiness,
  resolveCrossNodeStopped,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
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

function loopDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_to_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = loopDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'loop-persist',
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
    repoPath: '/tmp/aw-rfc056-c5',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedQRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  loopIter = 0,
): Promise<string> {
  const id = `nr_${nodeId}_${loopIter}_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: loopIter,
  })
  return id
}

async function seedDesignerRun(db: DbClient, taskId: string, loopIter = 0): Promise<string> {
  const id = `nr_d_${loopIter}_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: loopIter,
    preSnapshot: 'snap-c5',
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 C5 — wrapper-loop partial persistence', () => {
  test('iter 0 reject → resolveCrossNodeStopped true; persists into iter 1 query', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId, 0)
    const qIter0 = await seedQRun(db, taskId, 'questioner', 0)
    const a = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qIter0,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: a.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })
    // Persistence is keyed by (task, questioner node) — loop-iter agnostic.
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner')).toBe(true)
  })

  test('iter 1 evaluateDesignerRerunReadiness does NOT see iter 0 continue submissions as iter-1 feedback', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId, 0)
    const qIter0 = await seedQRun(db, taskId, 'questioner', 0)
    const iter0Session = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qIter0,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    // Iter 0 user submitted continue — designer reran already in iter 0.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: iter0Session.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    // Now the wrapper-loop steps to iter 1 — no iter-1 cross sessions yet.
    // Readiness scoped to loopIter=1 must NOT consider the iter 0 session.
    await seedDesignerRun(db, taskId, 1)
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition: loopDef(),
      loopIter: 1,
    })
    // No iter-1 sessions exist → ready=false (nothing to feed) AND
    // pendingCrossClarifyNodeIds excludes the iter-0 session.
    expect(readiness.ready).toBe(false)
    expect(readiness.sources.length).toBe(0)
  })

  test('iter 1 dispatchCrossClarifyNode for cross1 short-circuits to done (no new awaiting in iter 1)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId, 0)
    const qIter0 = await seedQRun(db, taskId, 'questioner', 0)
    const a = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qIter0,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: a.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })
    // Mint a fresh iter-1 pending cross-clarify node_run and dispatch.
    const iter1NodeRunId = `nr_cross1_iter1_${Math.random().toString(36).slice(2, 6)}`
    await db.insert(nodeRuns).values({
      id: iter1NodeRunId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 1,
    })
    const ret = await dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: iter1NodeRunId,
      definition: loopDef(),
    })
    expect(ret.kind).toBe('short-circuit-stop')

    // No new awaiting_human session was minted for iter 1.
    const iter1Awaiting = await db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, taskId),
          eq(crossClarifySessions.crossClarifyNodeId, 'cross1'),
          eq(crossClarifySessions.loopIter, 1),
        ),
      )
    expect(iter1Awaiting.length).toBe(0)
  })

  test('iter 0 directive=stop session row remains queryable after iter transition (persistence = retention, not forward-propagation)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId, 0)
    const qIter0 = await seedQRun(db, taskId, 'questioner', 0)
    const a = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qIter0,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: a.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })

    // The iter-0 row is still queryable; loop-iter and iteration counter
    // are unchanged. (Forward-propagation would have moved it forward —
    // which would lose the iter-0 audit trail.)
    const iter0Rows = await db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, taskId),
          eq(crossClarifySessions.crossClarifyNodeId, 'cross1'),
          eq(crossClarifySessions.directive, 'stop'),
        ),
      )
    expect(iter0Rows.length).toBe(1)
    expect(iter0Rows[0]?.loopIter).toBe(0)
    expect(iter0Rows[0]?.iteration).toBe(0)
  })
})
