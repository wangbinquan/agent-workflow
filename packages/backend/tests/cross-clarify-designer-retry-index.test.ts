// RFC-056 patch 2026-05-23 — designer's own pending row uses max(existing)+1.
//
// The 2026-05-22 cascade patch correctly bumped retry_index on every
// DOWNSTREAM cascade row (`cascadeDownstreamFromDesigner` uses
// `Math.max(existing retry_index) + 1` so the new pending always beats any
// prior done under `isFresherNodeRun`). But the same fix was NOT applied to
// the DESIGNER's own new pending row in the legacy designer-rerun mint —
// retry_index there was hardcoded to 0. (RFC-132: the unified dispatch mint,
// buildFrontierMintPlan, uses the same max(existing top-level)+1 formula.)
//
// Live task `01KS86DPCSERV7S41GQA5Y81RN` (workflow 01KS7C0K5ZRJ29AZD7J13C42C2
// "跨节点反问") hit this: designer ran many RFC-023 self-clarify rounds +
// RFC-042 same-session retries, pushing its latest done row to
// `clarify_iteration=6, retry_index=9`. After the user submitted the cross-
// clarify continue, the new pending designer row was minted at
// `clarify_iteration=6, retry_index=0`. `isFresherNodeRun` keys on
// `(clarifyIteration, retryIndex, id)` — NOT `clarifyIteration` — so
// the old done row (retry=9) beat the new pending (retry=0). The scheduler
// treated the designer as "completed", never dispatched the new row, and
// only the questioner's cascade-minted row (which DOES use max+1) ran.
// Observable symptom: "designer never re-executes after cross-clarify
// submit — only the questioner re-executes."
//
// This file locks the FIX: the designer's own new pending row carries
// retry_index strictly greater than every existing top-level row's
// retry_index at the same wrapper-loop iteration. If this test goes red,
// the freshness shield is gone — investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createClarifyRound } from '../src/services/clarify/service'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry. The upstream "designer" is now an explicit human reassign: take the answered
// round's questioner card, reassign it to the graph designer node (ADDS a roleKind='designer'
// row targeting it via defaultTargetNodeId), then dispatch that designer entry — which mints the
// designer rerun via the SAME buildFrontierMintPlan retry_index bump this file locks. This helper
// preserves the exact designer-rerun-mint coverage through the new path.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunId: string,
) {
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${crossClarifyNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${crossClarifyNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], actor)
}

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

function fixtureDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
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
  const def = fixtureDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'designer-retry-index',
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
    repoPath: '/tmp/aw-designer-retry-index',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

// RFC-096: seeded ids are MONOTONIC in seeding order (was Math.random — the
// production picker is pure ULID id-order since RFC-096, so a random id made
// `lastDesigner` selection nondeterministic; seeding order now IS causal
// order, matching how production mints rows).
let seedSeq = 0
async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  seedSeq += 1
  const id = `nr_${String(seedSeq).padStart(4, '0')}_${nodeId}`
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

describe('RFC-056 patch 2026-05-23 — designer rerun retry_index bump', () => {
  test('designer prior retry_index=9 (self-clarify storm) — new pending row strictly beats it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Mirror the live failure shape: designer ran many self-clarify rounds
    // + same-session retries, leaving its latest done at clarify_iter=6,
    // retry_index=9. Seed a handful of prior failed/done attempts so the
    // max-retry bump must walk all of them.
    // RFC-064: seed designer rows at clarifyIteration=0 so the
    // cross-clarify submit's max+1 bump produces a deterministic value;
    // the unified counter would otherwise inherit the existing
    // clarifyIteration and the assertion would need to track history.
    await seedRun(db, taskId, 'in', {})
    await seedRun(db, taskId, 'designer', {
      status: 'failed',
      retryIndex: 7,
    })
    await seedRun(db, taskId, 'designer', {
      status: 'interrupted',
      retryIndex: 8,
    })
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      preSnapshot: 'snap-d',
    })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 2 })

    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })

    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    const disp = await reassignThenDispatchDesigner(db, taskId, sess.intermediaryNodeRunId)
    expect(disp.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const designerPending = designerRows.find((r) => r.status === 'pending')
    expect(designerPending, 'a pending designer row must be minted').toBeDefined()
    // RFC-064: cross-clarify submit bumps the unified clarifyIteration to
    // max(participant, session) + 1 = 1 (all participants at 0 before).
    // The freshness shield: retry_index must beat every prior row at the
    // same (node, iteration). isFresherNodeRun ranks clarifyIteration first
    // (the new row at 1 > prior 0); retry_index is the tie-breaker for
    // same-clarify peers.
    expect(designerPending?.retryIndex).toBeGreaterThan(9)
  })

  test('designer first-ever rerun (no prior retries) — new pending retry_index=1', async () => {
    // No clarify storm: prior designer ran exactly once at retry_index=0.
    // The bump must still produce a strictly greater retry_index so the
    // contract is invariant w.r.t. the prior retry depth.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', { retryIndex: 0, preSnapshot: 'snap-d' })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 0 })

    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    await reassignThenDispatchDesigner(db, taskId, sess.intermediaryNodeRunId)

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const pending = designerRows.find((r) => r.status === 'pending')
    expect(pending?.retryIndex).toBe(1)
  })

  test('only same-iteration rows count toward the bump (wrapper-loop isolation)', async () => {
    // Designer ran twice at iteration=0 (retry 0, 5) then once at
    // iteration=1 (retry 0). A cross-clarify resolve at iteration=1 must
    // bump retry_index off iteration=1's max only — not iteration=0's.
    // RFC-096: `lastDesigner` is picked by pure ULID id order — the
    // iteration=1 row is seeded LAST so it has the largest id and wins
    // deterministically (startedAt fields kept for row realism only).
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', { iteration: 0, retryIndex: 0, startedAt: 100 })
    await seedRun(db, taskId, 'designer', { iteration: 0, retryIndex: 5, startedAt: 200 })
    await seedRun(db, taskId, 'designer', {
      iteration: 1,
      retryIndex: 0,
      preSnapshot: 'snap-d-iter1',
      startedAt: 300,
    })
    const qRun = await seedRun(db, taskId, 'questioner', {
      iteration: 1,
      retryIndex: 0,
      startedAt: 400,
    })

    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRun,
      targetConsumerNodeId: 'designer',
      loopIter: 1,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    await reassignThenDispatchDesigner(db, taskId, sess.intermediaryNodeRunId)

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    // The fresh pending is the only row at iteration=1 with status=pending.
    const pending = designerRows.find((r) => r.status === 'pending' && r.iteration === 1)
    expect(pending).toBeDefined()
    // Bump off iteration=1's max (=0), NOT iteration=0's max (=5).
    expect(pending?.retryIndex).toBe(1)
    // Iteration=0 rows untouched.
    const iter0Rows = designerRows.filter((r) => r.iteration === 0)
    expect(iter0Rows.length).toBe(2)
  })
})
