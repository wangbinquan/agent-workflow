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
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { loadUndispatchedDesignerTargets } from '../src/services/taskQuestions'
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

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
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
  opts: { deferred: boolean },
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
    questions: [mkQ('q1', 'designer-scoped?')],
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
