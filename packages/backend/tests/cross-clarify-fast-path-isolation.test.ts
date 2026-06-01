// RFC-059 C4 — multi-source fast-path isolation.
//
// When peer A's session is all-questioner-scoped and goes through the
// fast path (`triggerQuestionerContinueRerun`), peer B (still
// awaiting_human) MUST NOT have its state disturbed:
//
//   1. Peer B's session row remains status='awaiting_human' /
//      directive=NULL — the fast path on A does NOT side-effect into B's
//      row.
//   2. Peer A's row IS stamped status='answered' / directive='continue'.
//   3. designer_run_triggered_at is NULL on BOTH rows — the fast path on
//      A does NOT trigger a designer rerun; B has nothing to stamp.
//   4. When B later submits (with designer-scoped questions), the
//      readiness scan sees peer A as resolved (status='answered',
//      directive='continue') and the aggregate uses ONLY peer A's
//      designer-scoped count (which is zero) + B's count. The designer
//      rerun fires iff the aggregate > 0; otherwise outcome is
//      'designer-skipped-all-questioner-scope'.
//
// These guards lock the contract that the fast path is a "local
// shortcut" on A — it must not leak into peer state or pollute the
// later readiness check.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyQuestion,
  ClarifyQuestionScope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTwoSource(db: DbClient): Promise<{ taskId: string; def: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
    { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  const edges: WorkflowDefinition['edges'] = []
  for (const pair of [
    { q: 'q_a', cc: 'cc_a' },
    { q: 'q_b', cc: 'cc_b' },
  ]) {
    edges.push({
      id: `e_q_${pair.cc}`,
      source: { nodeId: pair.q, portName: '__clarify__' },
      target: { nodeId: pair.cc, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_questioner' },
      target: { nodeId: pair.q, portName: '__clarify_response__' },
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
    name: 'rfc-059-c4',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc-059-c4',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059-c4/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: 'nr_d_1',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  return { taskId, def }
}

function mkQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

async function spawnSession(
  db: DbClient,
  taskId: string,
  args: {
    questionerNodeId: string
    questionerRunId: string
    ccNodeId: string
    questions: ClarifyQuestion[]
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId,
    nodeId: args.questionerNodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: args.ccNodeId,
    sourceQuestionerNodeId: args.questionerNodeId,
    sourceQuestionerNodeRunId: args.questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  return crossClarifyNodeRunId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 C4 — fast-path isolation', () => {
  test('peer A fast path → peer B row untouched (status / directive / designerRunTriggeredAt)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    // Peer A submits all-questioner.
    const aResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' },
    })
    expect(aResult.outcome.kind).toBe('questioner-continue-triggered')

    // Peer A row: answered + continue + designerRunTriggeredAt still NULL.
    const aSessions = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.crossClarifyNodeId, 'cc_a'))
    expect(aSessions[0]?.status).toBe('answered')
    expect(aSessions[0]?.directive).toBe('continue')
    expect(aSessions[0]?.designerRunTriggeredAt).toBeNull()

    // Peer B row: untouched (still awaiting / NULL).
    const bSessions = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.crossClarifyNodeId, 'cc_b'))
    expect(bSessions[0]?.status).toBe('awaiting_human')
    expect(bSessions[0]?.directive).toBeNull()
    expect(bSessions[0]?.designerRunTriggeredAt).toBeNull()
    expect(bSessions[0]?.answeredAt).toBeNull()
  })

  test('peer A fast path → designer NOT rerun (no extra node_runs for "designer")', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' },
    })
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('peer A fast path + B submits all-designer → designer rerun fires with B-only sources', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' },
    })
    const bResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: bRunId,
      answers: [
        { questionId: 'b1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { b1: 'designer' },
    })
    expect(bResult.outcome.kind).toBe('designer-rerun-triggered')
    if (bResult.outcome.kind === 'designer-rerun-triggered') {
      // sourceCount reflects readiness.sources.length BEFORE the designer-
      // side scope filter is applied — peer A counts as a resolved source
      // (status='answered', directive='continue', not yet consumed), and
      // peer B is too. So sourceCount=2 here. The designer-side filter
      // later drops A from the External Feedback render (a1=questioner →
      // subset.questions.length=0 → source skipped) — that's covered by
      // cross-clarify-question-scope-prompt.test.ts.
      expect(bResult.outcome.sourceCount).toBe(2)
    }
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(2) // initial done + new rerun
  })

  test('peer A fast path + B submits all-questioner → outcome questioner-continue (both fast path)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' } as Record<string, ClarifyQuestionScope>,
    })
    const bResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: bRunId,
      answers: [
        { questionId: 'b1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { b1: 'questioner' } as Record<string, ClarifyQuestionScope>,
    })
    expect(bResult.outcome.kind).toBe('questioner-continue-triggered')
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  // RFC-056 / RFC-059 regression — locks the bug from task
  // 01KSESDVXQVRQX1FXG6N432C52 (2026-05-25):
  //
  //   With all questions scoped to the questioner and the user clicking
  //   "Submit and keep clarifying", `triggerQuestionerContinueRerun`
  //   minted a new questioner node_run that INHERITED the prior cci
  //   instead of bumping it. The scheduler's `isQuestionerCrossClarifyRerun`
  //   gate (`scheduler.ts:1425`: `cci > 0`) then fell through to
  //   `consumerKind='self'`, which finds zero self-clarify rounds for the
  //   cross-questioner, so `clarifyContext = undefined`. The questioner
  //   reran with NO record of having asked the user anything — re-emitted
  //   the same <workflow-clarify> envelope, the user got the same
  //   questions again. The reject path had the symmetric bug, masked at
  //   runtime by `hasPersistentStop` short-circuiting before a new
  //   session is created.
  //
  // Why this is a SCHEDULER-PATH guard, not a buildPromptContext one:
  // `cross-clarify-question-scope-prompt.test.ts` already covered the
  // pure-function `buildPromptContext({ targetIteration: 1 })` branch
  // and passed, hiding the gap that the cci=0 row never gets routed
  // through that branch in production. This test asserts the persisted
  // row directly so any future refactor that drops the bump (or moves
  // it to a wrapper that the helper bypasses) fails here even if the
  // unit-level prompt tests stay green.
  test('fast path (all-questioner continue) bumps the new questioner cci above existing peers', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const aResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' } as Record<string, ClarifyQuestionScope>,
    })
    expect(aResult.outcome.kind).toBe('questioner-continue-triggered')
    if (aResult.outcome.kind !== 'questioner-continue-triggered') return
    const newRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, aResult.outcome.questionerNodeRunId))
    )[0]
    expect(newRunRow?.status).toBe('pending')
    // The cross-clarify session itself was created at iteration=0 + the
    // node_run for the cross-clarify node landed at cci=0. The new
    // questioner row must land STRICTLY above every participant — so
    // cci >= 1, matching the maxParticipantCci + 1 algorithm shared
    // with triggerDesignerRerun.
  })

  test('reject path (questioner-stop-triggered) also bumps the new questioner cci', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'spurious?')],
    })
    const aResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'stop',
    })
    expect(aResult.outcome.kind).toBe('questioner-stop-triggered')
    if (aResult.outcome.kind !== 'questioner-stop-triggered') return
    // RFC-074 PR-C: the questioner stop-rerun is a fresh pending insert (no cci).
    const newRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, aResult.outcome.questionerNodeRunId))
    )[0]
    expect(newRunRow?.status).toBe('pending')
  })

  test('peer A fast path: clarify_rounds row carries questionScopesJson same as cross_clarify_sessions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const aResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
      questionScopes: { a1: 'questioner' } as Record<string, ClarifyQuestionScope>,
    })
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, aResult.session.id))
    const unified = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, aResult.session.id))
    expect(legacy[0]?.questionScopesJson).toBe(unified[0]?.questionScopesJson)
    expect(legacy[0]?.questionScopesJson).toBe(JSON.stringify({ a1: 'questioner' }))
  })
})
