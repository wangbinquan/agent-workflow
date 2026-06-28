// RFC-120 T9 (model A) — deferred question dispatch backend foundation.
//
// Locks the four foundation behaviors (design §14 / §16 C1-H4 / §17):
//   A. submit split — tasks.deferred_question_dispatch FALSE = byte-for-byte
//      today's immediate dispatch (golden-lock: outcome 'designer-rerun-triggered');
//      TRUE + ≥1 designer-scoped question → outcome 'designer-deferred', NO designer
//      rerun minted, designer task_questions rows created undispatched (trigger_run_id
//      NULL). questioner-only rounds unchanged regardless of the flag.
//   B. PARK gate (pure deriveFrontier) — a deferred designer handler node is kept OUT
//      of `completed` (downstream blocked) and bubbled awaiting_human; empty deferred
//      set = byte-for-byte today's frontier.
//   C. T2 invariant + S2 stuck detector treat the park (task awaiting_human with no
//      awaiting_human node_run / no open clarify_session) as VALID for a deferred task,
//      and still fire for a non-deferred task (golden-lock control).
//   D. dispatchTaskQuestions — mint one rerun per effective target, stamp trigger_run_id
//      (releases the gate); CAS idempotency: a repeated dispatch never double-mints.
//
// The flag is the golden-lock boundary: every gate consumer is inert for a
// non-deferred task (loadUndispatchedDesignerTargets self-gates on the flag).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { markClarifyRoundsConsumedBy } from '../src/services/clarifyRounds'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import {
  loadUndispatchedDesignerTargets,
  reassignTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { deriveFrontier } from '../src/services/scheduler'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyQuestion,
  NodeKind,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node with NO __external_feedback__ edge — a valid reassign target
// (canReassign accepts any agent node) but an UNSAFE dispatch target in v1 (H3).
const OTHER = 'other'

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
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

/** Seed a task (with the deferred flag set) + workflow snapshot + the designer's
 *  prior `done` draft + the questioner's `done` asking run, then open one
 *  cross-clarify session and return its node_run id. */
async function seedTask(
  db: DbClient,
  opts: { deferred: boolean; questions?: ClarifyQuestion[] },
): Promise<{ taskId: string; crossClarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc120-t9',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc120-t9',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-t9/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: opts.deferred,
  })
  await db.insert(nodeRuns).values({
    id: `nr_d_${taskId}`,
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  const questionerRunId = `nr_q_${taskId}`
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: CC,
    sourceQuestionerNodeId: QUESTIONER,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: DESIGNER,
    loopIter: 0,
    questions: opts.questions ?? [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, crossClarifyNodeRunId }
}

function ans(qid: string) {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// A — submit split.
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — submit split (defer vs immediate)', () => {
  test('golden-lock: flag FALSE designer-scoped answer → designer-rerun-triggered (immediate)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: false })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      // no questionScopes → all-designer (CLARIFY_QUESTION_SCOPE_DEFAULT)
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    // a fresh designer rerun was minted immediately
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(2) // draft + rerun
    // no park: non-deferred task always resolves the gate empty
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })

  test('flag TRUE designer-scoped answer → designer-deferred + NO rerun + undispatched entry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-deferred')
    if (ret.outcome.kind === 'designer-deferred') {
      expect(ret.outcome.deferredQuestionCount).toBe(1)
    }
    // the answer IS recorded (round answered) but NO designer rerun minted
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(1) // draft only — deferred
    // the designer task_questions entry was created eagerly + undispatched
    const designerEntries = await db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    expect(designerEntries.length).toBe(1)
    expect(designerEntries[0]?.triggerRunId).toBeNull()
    expect(designerEntries[0]?.defaultTargetNodeId).toBe(DESIGNER)
    // the park gate now sees the designer as an undispatched target
    expect([...(await loadUndispatchedDesignerTargets(db, taskId))]).toEqual([DESIGNER])
  })

  test('flag TRUE questioner-only answer → questioner-continue (unchanged) + gate empty', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      questionScopes: { q1: 'questioner' },
    })
    expect(ret.outcome.kind).toBe('questioner-continue-triggered')
    // no designer entry → no park even though the task is flagged
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B — PARK gate (pure deriveFrontier).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — frontier park gate', () => {
  type Row = typeof nodeRuns.$inferSelect
  let seq = 0
  function row(nodeId: string, status: string): Row {
    seq += 1
    return {
      id: `01R${String(seq).padStart(4, '0')}`,
      nodeId,
      iteration: 0,
      status,
      parentNodeRunId: null,
    } as unknown as Row
  }
  const defOf = (nodes: Array<{ id: string; kind: NodeKind }>) => ({
    definition: { nodes, edges: [] } as unknown as WorkflowDefinition,
    scopeNodes: nodes as unknown as WorkflowNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  })
  const NONE: ReadonlySet<string> = new Set()
  const ups = (m: Record<string, string[]>) => new Map(Object.entries(m))

  test('deferred designer parked → not completed, awaiting_human, downstream blocked', () => {
    const { definition, scopeNodes, scopeIds } = defOf([
      { id: DESIGNER, kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    const rows = [row(DESIGNER, 'done'), row('down', 'pending')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ down: [DESIGNER] }),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      new Set([DESIGNER]), // deferredHandlerNodeIds
    )
    expect(f.completed.has(DESIGNER)).toBe(false)
    expect(f.awaitingHuman).toContain(DESIGNER)
    expect(f.ready).not.toContain('down') // downstream blocked (designer not completed)
    expect(f.ready).not.toContain(DESIGNER)
  })

  test('golden-lock: empty deferred set → designer completed, downstream ready', () => {
    const { definition, scopeNodes, scopeIds } = defOf([
      { id: DESIGNER, kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    const rows = [row(DESIGNER, 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ down: [DESIGNER] }),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      NONE, // no deferred nodes
    )
    expect(f.completed.has(DESIGNER)).toBe(true)
    expect(f.ready).toContain('down')
    expect(f.awaitingHuman).not.toContain(DESIGNER)
  })
})

// ---------------------------------------------------------------------------
// C — T2 invariant + S2 stuck detector exemption.
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — T2 / S2 treat the park as valid (deferred) and corrupt (control)', () => {
  test('T2: deferred task awaiting_human + undispatched designer → no T2 alert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // park the task (the scheduler would do this at quiescence)
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(0)
  })

  test('T2 control: non-deferred task awaiting_human + no awaiting_human run → T2 fires', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: false })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    // non-deferred → loadUndispatchedDesignerTargets is empty → T2 fires as before
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(1)
  })

  test('S2: deferred task awaiting_human + undispatched designer → no S2 finding', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // park + age past the freshness gate (startedAt long ago, no events)
    await db
      .update(tasks)
      .set({ status: 'awaiting_human', startedAt: Date.now() - 60 * 60 * 1000 })
      .where(eq(tasks.id, taskId))
    const result = await runStuckTaskDetector({ db, stuckThresholdMs: 1000 })
    expect(result.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// D — dispatchTaskQuestions (mint / stamp / release + CAS idempotency).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — dispatchTaskQuestions', () => {
  async function seedDeferredAnswered(db: DbClient) {
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    )[0]!
    return { taskId, entryId: entry.id }
  }
  const actor = { userId: 'u1', role: 'owner' as const }

  test('mint per effective target + trigger_run_id stamped + gate released', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, entryId } = await seedDeferredAnswered(db)

    const result = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)

    // a fresh pending designer rerun was minted
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(2) // draft + dispatched rerun
    const pending = designerRuns.find((r) => r.status === 'pending')
    expect(pending).toBeDefined()
    expect(pending?.rerunCause).toBe('cross-clarify-answer')

    // the entry now carries the rerun id, and the gate is released
    const entry = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryId)))[0]
    expect(entry?.triggerRunId).toBe(result.reruns[0]?.nodeRunId)
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })

  test('CAS idempotency: double dispatch does not double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, entryId } = await seedDeferredAnswered(db)

    const first = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(first.reruns.length).toBe(1)
    const second = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(second.reruns.length).toBe(0) // already claimed → no-op

    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.filter((r) => r.status === 'pending').length).toBe(1) // exactly one rerun
  })
})

// ---------------------------------------------------------------------------
// E — Codex impl-gate folds: H1 (graph-node granularity vs round-scoped
// consumption), H2 (atomic claim+mint, no orphan/phantom), H3 (unsafe targets).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — dispatch correctness (Codex impl-gate H1/H2/H3)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  test('H1: dispatching ONE entry of a multi-question round stamps the WHOLE node group (no stranded sibling)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    expect(entries.length).toBe(2) // q1 + q2 both → designer

    // dispatch only q1 → expansion stamps BOTH (round/graph-scoped consumption)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.entryIds.length).toBe(2) // whole node group

    const after = await designerEntries(db, taskId)
    expect(after.every((e) => e.triggerRunId === result.reruns[0]?.nodeRunId)).toBe(true)
    // no sibling stranded → gate fully released
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
    // exactly ONE rerun for the node (not one-per-question)
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.filter((r) => r.status === 'pending').length).toBe(1)
  })

  test('H2: a stamped entry always resolves to an EXISTING node_run (no phantom / orphan)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    const stampedId = (await designerEntries(db, taskId))[0]!.triggerRunId
    expect(stampedId).toBe(result.reruns[0]!.nodeRunId)
    // the stamped run is a REAL row (claim+mint committed together, no orphan)
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, stampedId!)))[0]
    expect(run).toBeDefined()
    expect(run?.nodeId).toBe(DESIGNER)
  })

  // Run-scoped injection layer — override to a node WITH a prior run but NO
  // __external_feedback__ edge now SUCCEEDS and the rerun carries the answer
  // (flips the old H3 reject). Never-run override is still rejected.
  test('override to a run-but-no-edge node → dispatch succeeds; run-scoped feedback carries the answer; stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has a prior node_run (so it is not never-run) but no feedback edge.
    await db.insert(nodeRuns).values({
      id: `nr_other_${taskId}`,
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER) // dispatched to the override node
    const runId = result.reruns[0]!.nodeRunId

    // entry stamped + a pending rerun minted on OTHER (no edge), not on DESIGNER
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.some((r) => r.id === runId && r.status === 'pending')).toBe(true)

    // run-scoped External Feedback for THIS run carries the human answer, even
    // though OTHER has no __external_feedback__ graph edge.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: OTHER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('A') // the selected answer label
    expect(ctx?.block).toContain(QUESTIONER) // the source questioner heading
  })

  test('never-run override target → rejected (clean ConflictError, nothing minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has NO prior node_run.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-unsafe-dispatch-target')
    // nothing minted; entry stays claimable
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBeNull()
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.length).toBe(0)
  })

  test('golden-lock: buildExternalFeedbackContext with no dispatchedRunId (or no claiming entries) uses the graph path', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // No dispatchedRunId → graph path. The designer (DESIGNER) HAS the edge, so
    // the graph path surfaces the answered unconsumed session.
    const graph = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(graph?.block).toContain('A')
    // A bogus dispatchedRunId with NO claiming entries → falls through to the
    // SAME graph path (byte-for-byte).
    const fallthrough = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: 'nr_does_not_claim_anything',
    })
    expect(fallthrough?.block).toBe(graph?.block ?? '')
  })

  test('override-aware consumption: the overridden round is consumed by the OVERRIDE run, so the graph designer no longer re-injects it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: `nr_other_${taskId}`,
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    const overrideRunId = result.reruns[0]!.nodeRunId

    // Before consumption: the graph designer (DESIGNER) would still see the round.
    const before = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(before?.block).toContain('A')

    // The OVERRIDE run completes → override-aware markClarifyRoundsConsumedBy
    // consumes the round even though its targetConsumerNodeId is DESIGNER, not OTHER.
    await markClarifyRoundsConsumedBy(db, {
      id: overrideRunId,
      taskId,
      nodeId: OTHER,
      shardKey: null,
    })
    const session = (
      await db
        .select()
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    )[0]
    expect(session?.consumedByConsumerRunId).toBe(overrideRunId)

    // After consumption: the graph designer no longer re-injects the overridden
    // round (no double-handling).
    const after = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(after).toBeUndefined()
  })
})
