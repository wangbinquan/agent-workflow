// RFC-120 T9 (model A) — deferred question dispatch backend foundation.
//
// Locks the four foundation behaviors (design §14 / §16 C1-H4 / §17):
//   A. answer outcomes — the CONTROL channel (sealRoundQuestions, the board's per-question
//      seal) PARKS: round answered, designer task_questions rows created undispatched
//      (trigger_run_id NULL), NO designer rerun until an explicit board dispatch. The
//      unified QUICK channel (autoDispatchClarifyRound) auto-dispatches instead (RFC-132
//      §6; locked in rfc128-p5-d + the PR-B test below). questioner-scope answers rerun
//      the questioner via the same dispatch.
//   B. PARK gate (pure deriveFrontier) — a parked designer handler node is kept OUT
//      of `completed` (downstream blocked) and bubbled awaiting_human; empty deferred
//      set = byte-for-byte today's frontier.
//   C. T2 invariant + S2 stuck detector treat the park (task awaiting_human with no
//      awaiting_human node_run / no open clarify_session) as VALID, and still fire for a
//      fully-dispatched task (control).
//   D. dispatchTaskQuestions — mint one rerun per effective target, stamp trigger_run_id
//      (releases the gate); CAS idempotency: a repeated dispatch never double-mints.
//
// RFC-132: the `deferredQuestionDispatch` flag is VESTIGIAL (every task is the unified
// deferred model); the legacy immediate mint + the flag-based submit split are deleted.
// The park fixtures below drive the CONTROL channel (seal), mirroring the board flow.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { bindTriggerRun, buildClarifyQueueContext } from '../src/services/clarifyQueue'
import {
  confirmTaskQuestion,
  listTaskQuestions,
  loadUndispatchedDesignerTargets,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { deriveFrontier } from '../src/services/scheduler'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import {} from '@agent-workflow/shared'
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
  opts: { deferred: boolean; questions?: ClarifyQuestion[]; ownerUserId?: string },
): Promise<{ taskId: string; intermediaryNodeRunId: string }> {
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
    ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-t9/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  // ULID ids (production-accurate): node_run freshness — and resolveHandlerRun's
  // lineage window — is pure ULID id-order, so these seeded runs must sort BEFORE
  // the later-minted dispatch reruns (a non-ULID string id sorts AFTER ULIDs and
  // would pollute the lineage window).
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: CC,
    askingNodeId: QUESTIONER,
    askingNodeRunId: questionerRunId,
    targetConsumerNodeId: DESIGNER,
    loopIter: 0,
    questions: opts.questions ?? [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, intermediaryNodeRunId: crossClarifyNodeRunId }
}

/** Seed a DEFERRED task whose designer has TWO sibling cross-clarify nodes
 *  (cc_a/q_a, cc_b/q_b both → DESIGNER) — for the H3 multi-source readiness gate. */
async function seedTwoSource(
  db: DbClient,
): Promise<{ taskId: string; ccA: string; ccB: string; def: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
    { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
    // a plain no-edge agent — a valid override target (run-scoped) for the C1 test.
    { id: 'fixer', kind: 'agent-single', agentName: 'fixer' } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  const edges: WorkflowDefinition['edges'] = []
  for (const { q, cc } of [
    { q: 'q_a', cc: 'cc_a' },
    { q: 'q_b', cc: 'cc_b' },
  ]) {
    edges.push({
      id: `e_q_${cc}`,
      source: { nodeId: q, portName: '__clarify__' },
      target: { nodeId: cc, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${cc}`,
      source: { nodeId: cc, portName: 'to_designer' },
      target: { nodeId: DESIGNER, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${cc}`,
      source: { nodeId: cc, portName: 'to_questioner' },
      target: { nodeId: q, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc120-t9-2src',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc120-t9-2src',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-t9-2src/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db
    .insert(nodeRuns)
    .values({ id: ulid(), taskId, nodeId: DESIGNER, status: 'done', retryIndex: 0, iteration: 0 })
  // fixer prior run (so an override dispatch to it is not rejected as never-run).
  await db
    .insert(nodeRuns)
    .values({ id: ulid(), taskId, nodeId: 'fixer', status: 'done', retryIndex: 0, iteration: 0 })
  const open = async (q: string, cc: string): Promise<string> => {
    const runId = ulid()
    await db
      .insert(nodeRuns)
      .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: cc,
      askingNodeId: q,
      askingNodeRunId: runId,
      targetConsumerNodeId: DESIGNER,
      loopIter: 0,
      questions: [mkQ(cc === 'cc_a' ? 'a1' : 'b1', 'designer-scoped?')],
    })
    return crossClarifyNodeRunId
  }
  const ccA = await open('q_a', 'cc_a')
  const ccB = await open('q_b', 'cc_b')
  return { taskId, ccA, ccB, def }
}

function ans(qid: string) {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

/** RFC-162: reconcile no longer derives a designer entry from a cross round's scope
 *  (designer-by-default deleted). A designer handler is now ADDED by a human reassign of the
 *  round's questioner entry to a node OTHER than the asking/questioner node (→ 'added-designer',
 *  `defaultTargetNodeId` = that node, `overrideTargetNodeId` = null). This helper reproduces the
 *  old designer-by-default shape AFTER a seal: it reassigns every questioner entry (optionally
 *  scoped to one origin round) to `designerNodeId`, minting a `roleKind='designer'` row whose
 *  `defaultTargetNodeId` == `designerNodeId` — the exact shape the §18 dispatch mechanics below
 *  used to get for free. Call once per (origin → graph designer) for multi-source fixtures. */
async function seedDesignerEntries(
  db: DbClient,
  taskId: string,
  designerNodeId: string,
  actor: { userId: string; role: string },
  opts: { originNodeRunId?: string } = {},
): Promise<void> {
  const questioners = (
    await db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'questioner')))
  ).filter((e) => opts.originNodeRunId === undefined || e.originNodeRunId === opts.originNodeRunId)
  for (const q of questioners) await reassignTaskQuestion(db, q.id, designerNodeId, actor)
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// A — answer outcomes (RFC-132: control-channel seal parks; quick channel dispatches).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — answer outcomes (control-channel park vs quick-channel dispatch)', () => {
  test('control-channel seal (designer scope) → PARK: NO rerun + undispatched entry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    const sealed = await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(sealed.roundFullySealed).toBe(true)
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign
    // (targets the graph designer node, reproducing the old designer-by-default shape).
    await seedDesignerEntries(db, taskId, DESIGNER, { userId: 'u1', role: 'owner' })
    // the answer IS recorded (round answered) but NO designer rerun minted
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(1) // draft only — parked
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

  test('quick-channel questioner-only answer → questioner rerun via dispatch + gate empty', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      actor: { userId: 'u1', role: 'owner' },
    })
    // the questioner rerun is minted through the unified dispatch (not an immediate mint).
    expect(ret.dispatch.reruns.some((r) => r.targetNodeId === QUESTIONER)).toBe(true)
    // no designer entry → no park
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
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: add the undispatched designer entry that parks the task (reconcile no longer
    // derives it from scope) — this is what T2 must treat as a valid park.
    await seedDesignerEntries(db, taskId, DESIGNER, { userId: 'u1', role: 'owner' })
    // park the task (the scheduler would do this at quiescence)
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(0)
  })

  test('T2 control: fully-DISPATCHED task awaiting_human + no awaiting_human run → T2 fires', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: false })
    // The unified quick channel dispatches everything (designer + questioner) → no park.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      actor: { userId: 'u1', role: 'owner' },
    })
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    // fully dispatched → loadUndispatchedDesignerTargets is empty → T2 fires as before
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(1)
  })

  test('S2: deferred task awaiting_human + undispatched designer → no S2 finding', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: add the undispatched designer entry that parks the task (reconcile no longer
    // derives it from scope) — S2 must exempt this valid deferred park.
    await seedDesignerEntries(db, taskId, DESIGNER, { userId: 'u1', role: 'owner' })
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
// RFC-128 P0 net (behavior #3): 整轮 seal 现状，P1 逐题改造勿破。本 describe + 下方
// 「dispatch correctness」是 §18 deferred designer「部分下发」现状的权威锁——dispatch
// 戳 dispatched_at + mint frontier rerun + 释放 park gate、`dispatched_at IS NULL`
// CAS 防重（双次 dispatch 不双 mint）。RFC-128 把 designer 域逐题下发铺到全角色时，这些
// 整轮 answered 之后才下发的不变量不可放松（P1 仅把「整轮 answered 后」的前置改为「该题
// 已 sealed 后」，CAS / frontier mint / 一节点一条 rerun 的语义须逐字保留）。
describe('RFC-120 T9 — dispatchTaskQuestions', () => {
  async function seedDeferredAnswered(db: DbClient) {
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign
    // (targets the graph designer node, reproducing the old designer-by-default shape).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    )[0]!
    return { taskId, entryId: entry.id }
  }
  const actor = { userId: 'u1', role: 'owner' as const }

  test('dispatch stamps dispatched_at + mints the frontier rerun + releases the gate (NO trigger_run_id at dispatch)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, entryId } = await seedDeferredAnswered(db)

    const result = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    expect(result.dispatchedEntryIds).toEqual([entryId])

    // a fresh pending designer rerun was minted (the upstream frontier — the only node)
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(2) // draft + frontier rerun
    const pending = designerRuns.find((r) => r.status === 'pending')
    expect(pending).toBeDefined()
    expect(pending?.rerunCause).toBe('cross-clarify-answer')
    expect(pending?.id).toBe(result.reruns[0]?.nodeRunId)

    // RFC-120 §18: dispatch stamps dispatched_at (committed for execution) + dispatched_by,
    // NOT trigger_run_id — binding happens at the node's RERUN (buildExternalFeedbackContext).
    const entry = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryId)))[0]
    expect(entry?.dispatchedAt).not.toBeNull()
    expect(entry?.dispatchedBy).toBe('u1')
    expect(entry?.triggerRunId).toBeNull()
    // gate released (dispatched_at set → leaves the undispatched set)
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

  test('a round → one node: dispatching its designer questions mints exactly ONE frontier rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (reconcile no longer derives
    // them from scope) — both q1 + q2 target the graph designer DESIGNER (same handler).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    expect(entries.length).toBe(2) // q1 + q2 both → DESIGNER (same handler)

    // dispatch both → affected = {DESIGNER}, frontier = {DESIGNER} → exactly ONE rerun
    // (NOT one-per-question), both entries committed.
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id, entries[1]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.entryIds.length).toBe(2) // both routed to the one frontier node

    const after = await designerEntries(db, taskId)
    expect(after.every((e) => e.dispatchedAt !== null)).toBe(true)
    expect(after.every((e) => e.triggerRunId === null)).toBe(true) // NOT bound at dispatch
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0) // gate released
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.filter((r) => r.status === 'pending').length).toBe(1)
  })

  test('H1(re-gate): subset dispatch does NOT park the node while q1 is in-flight (q1 runs, q2 stays staged); re-parks once q1 is consumed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    // dispatch ONLY q1 (both → same handler DESIGNER, so the per-origin guard allows it).
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.dispatchedEntryIds).toEqual([entries[0]!.id])
    const runId = result.reruns[0]!.nodeRunId
    const after = await designerEntries(db, taskId)
    expect(after.find((e) => e.id === entries[0]!.id)?.dispatchedAt).not.toBeNull()
    expect(after.find((e) => e.id === entries[1]!.id)?.dispatchedAt).toBeNull() // q2 undispatched

    // Codex H1 re-gate: q1 is dispatched + IN-FLIGHT (its rerun pending). The node must NOT
    // be parked (else q1's minted rerun would be STRANDED) even though q2 is undispatched.
    expect((await loadUndispatchedDesignerTargets(db, taskId)).has(DESIGNER)).toBe(false)

    // The rerun dispatches → binds q1 (the unified queue injector stamps trigger_run_id);
    // still not parked while the run is in flight.
    await bindTriggerRun(db, [entries[0]!.id], runId)
    expect((await loadUndispatchedDesignerTargets(db, taskId)).has(DESIGNER)).toBe(false)

    // q1's rerun finishes done+output → q1 consumed. Now the node RE-PARKS for the still-
    // undispatched q2 (so a later dispatch of q2 isn't lost to an already-completing task).
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
    await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'result', content: 'x' })
    expect((await loadUndispatchedDesignerTargets(db, taskId)).has(DESIGNER)).toBe(true)
  })

  test('H1(re-gate): a node with an in-flight dispatched question is DISPATCHABLE in deriveFrontier (not parked)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor) // dispatch q1 only

    // The park set excludes DESIGNER (in-flight q1) → deriveFrontier does NOT bucket it into
    // awaitingHuman; its pending rerun is dispatchable (not stranded).
    const deferred = await loadUndispatchedDesignerTargets(db, taskId)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const scopeNodes = liveDef().nodes as unknown as WorkflowNode[]
    const f = deriveFrontier(
      rows,
      liveDef(),
      scopeNodes,
      new Set(scopeNodes.map((n) => n.id)),
      0,
      new Map(),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      deferred,
    )
    expect(f.awaitingHuman).not.toContain(DESIGNER)
    expect(f.ready).toContain(DESIGNER) // q1's pending rerun runs
  })

  test('(a) one batch of two same-node questions → exactly ONE rerun rendering BOTH', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    // q1 + q2 to the same node in ONE dispatch → byTarget groups them → exactly ONE rerun.
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id, entries[1]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.entryIds.length).toBe(2)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(pending.length).toBe(1)
  })

  test('(b) dispatching q2 while the node has an IN-FLIGHT rerun → rejected task-question-node-dispatch-in-flight (nothing stamped)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    const q1 = entries.find((e) => e.questionId === 'q1')!
    const q2 = entries.find((e) => e.questionId === 'q2')!

    // Dispatch q1 → DESIGNER's cross-clarify-answer rerun is pending (in-flight).
    await dispatchTaskQuestions(db, taskId, [q1.id], actor)
    // A SECOND, separate dispatch of q2 to the same (busy) node is rejected — minting a
    // second rerun on the same (node, iteration) would conflict via ULID freshness.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [q2.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-node-dispatch-in-flight')
    // q2 stays uncommitted (nothing stamped); exactly ONE pending rerun on DESIGNER.
    expect((await designerEntries(db, taskId)).find((e) => e.id === q2.id)?.dispatchedAt).toBeNull()
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(pending.length).toBe(1)
  })

  test('(c) after the node rerun is DONE, dispatching q2 succeeds with a fresh rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    const q1 = entries.find((e) => e.questionId === 'q1')!
    const q2 = entries.find((e) => e.questionId === 'q2')!

    // q1 dispatched → P; P renders/binds q1 then finishes done+output (no longer in-flight).
    const d1 = await dispatchTaskQuestions(db, taskId, [q1.id], actor)
    const P = d1.reruns[0]!.nodeRunId
    await bindTriggerRun(db, [q1.id], P)
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, P))
    await db.insert(nodeRunOutputs).values({ nodeRunId: P, portName: 'result', content: 'x' })

    // Now the node is free → dispatching q2 mints a FRESH rerun P2 (no conflict).
    const d2 = await dispatchTaskQuestions(db, taskId, [q2.id], actor)
    const P2 = d2.reruns[0]!.nodeRunId
    await bindTriggerRun(db, [q2.id], P2)
    expect(P2).not.toBe(P)
    const p2row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, P2)))[0]
    expect(p2row?.status).toBe('pending')
    expect(p2row?.rerunCause).toBe('cross-clarify-answer')
    expect((await designerEntries(db, taskId)).find((e) => e.id === q2.id)?.triggerRunId).toBe(P2)
  })

  test('(failed-run guard) q1 bound + its handler run FAILED (unconsumed) → dispatching q2 to the SAME node is REJECTED', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: add a designer handler per question via reassign (both q1 + q2 → DESIGNER).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    const q1 = entries.find((e) => e.questionId === 'q1')!
    const q2 = entries.find((e) => e.questionId === 'q2')!

    // q1 dispatched → P; P binds q1; P FAILS with no output → q1 is UNCONSUMED (not done+output).
    const d1 = await dispatchTaskQuestions(db, taskId, [q1.id], actor)
    const P = d1.reruns[0]!.nodeRunId
    await bindTriggerRun(db, [q1.id], P)
    expect((await designerEntries(db, taskId)).find((e) => e.id === q1.id)?.triggerRunId).toBe(P)
    await db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, P))

    // Dispatching q2 to the SAME node is REJECTED — q1 is still OPEN (failed ≠ consumed). A
    // newer rerun would become the upper bound of q1's lineage window, so a later revival /
    // retry of P would never re-render q1's feedback (stuck processing). So we block it.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [q2.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-node-dispatch-in-flight')
    // q2 stays uncommitted; P stays the ONLY designer cross-clarify-answer rerun (revivable).
    expect((await designerEntries(db, taskId)).find((e) => e.id === q2.id)?.dispatchedAt).toBeNull()
    const designerReruns = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.rerunCause, 'cross-clarify-answer'),
        ),
      )
    expect(designerReruns.length).toBe(1)
    expect(designerReruns[0]?.id).toBe(P)

    // Once P's revival reaches done+output (q1 consumed), dispatching q2 SUCCEEDS (test c).
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, P))
    await db.insert(nodeRunOutputs).values({ nodeRunId: P, portName: 'result', content: 'x' })
    const d2 = await dispatchTaskQuestions(db, taskId, [q2.id], actor)
    expect(d2.reruns.length).toBe(1)
    expect(d2.reruns[0]?.nodeRunId).not.toBe(P)
  })

  test('(dispatch/reassign race) a concurrent reassign before the tx → ROLLS BACK task-question-target-changed; re-run with the new target succeeds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER (the reassign target B) needs a prior run to be a valid frontier mint target.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign
    // (targets the graph designer node, reproducing the old designer-by-default shape).
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.defaultTargetNodeId).toBe(DESIGNER)

    // A db Proxy that fires a ONE-SHOT reassign (default → OTHER) on the FIRST nodeRuns read,
    // which happens AFTER dispatch snapshots `requested` (target DESIGNER) and BEFORE its tx.
    // The reassign uses the REAL db so it doesn't re-trigger the proxy.
    let fired = false
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        const orig = Reflect.get(target, prop, receiver)
        if (prop !== 'select') return orig
        return (...selectArgs: unknown[]) => {
          const builder = (orig as (...a: unknown[]) => Record<string, unknown>).apply(
            target,
            selectArgs,
          )
          const origFrom = (builder.from as (t: unknown) => Record<string, unknown>).bind(builder)
          builder.from = (tbl: unknown) => {
            const q = origFrom(tbl)
            if (tbl === nodeRuns && !fired) {
              fired = true
              const origThen = (q.then as (...a: unknown[]) => unknown).bind(q)
              q.then = (onF: unknown, onR: unknown) =>
                reassignTaskQuestion(db, entry.id, OTHER, actor).then(
                  () => origThen(onF, onR),
                  onR as never,
                )
            }
            return q
          }
          return builder
        }
      },
    }) as typeof db

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(racingDb, taskId, [entry.id], actor)
    } catch (e) {
      threw = e
    }
    expect(fired).toBe(true) // the concurrent reassign actually ran mid-dispatch
    expect((threw as { code?: string }).code).toBe('task-question-target-changed')
    // Nothing stamped; the reassign DID commit (RFC-162: re-targets the designer row's
    // defaultTargetNodeId → OTHER, override stays null); NO rerun minted anywhere.
    const after = (await designerEntries(db, taskId))[0]!
    expect(after.dispatchedAt).toBeNull()
    expect(after.defaultTargetNodeId).toBe(OTHER)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0)

    // RFC-131 T4 去借壳: after the reassign, effectiveTarget=OTHER — the rerun is minted ON OTHER
    // (which has a prior run seeded above), running its OWN agent (agentOverrideName null, no borrow).
    // The race rollback mechanism (task-question-target-changed) is unchanged — only the mint target.
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER)
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(OTHER)
    expect(minted?.agentOverrideName).toBeNull() // 去借壳: OTHER runs its OWN agent
  })

  test('a stamped frontier rerun always resolves to an EXISTING node_run (no phantom / orphan)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    const rerunId = result.reruns[0]!.nodeRunId
    // the minted run is a REAL row (stamp+mint committed together, no orphan); the entry
    // is committed (dispatched_at) but NOT yet bound (trigger_run_id NULL).
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunId)))[0]
    expect(run).toBeDefined()
    expect(run?.nodeId).toBe(DESIGNER)
    expect(run?.status).toBe('pending')
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.dispatchedAt).not.toBeNull()
    expect(entry.triggerRunId).toBeNull()
  })

  // Per-node-queue injection — RFC-131 T4 去借壳: reassign to a node WITH a prior run but NO
  // __external_feedback__ edge SUCCEEDS; the target OTHER is the frontier (no affected ancestor),
  // and ITS rerun (running OTHER's OWN agent) binds + injects the answer from its per-node queue.
  test('reassign to a run-but-no-edge node → 去借壳: mint the TARGET itself (own agent); the target queue injection carries + binds the answer', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has a prior node_run + no feedback edge — a valid reassign target.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it to OTHER.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    // RFC-131 T4 去借壳: effectiveTarget=OTHER → dispatch mints OTHER itself (NOT DESIGNER), running
    // OTHER's OWN agent (no agent_override_name). OTHER is the frontier (it has a prior run).
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER) // frontier is the effective target
    const runId = result.reruns[0]!.nodeRunId

    // entry committed (dispatched_at) but NOT bound yet; the pending rerun is on OTHER and runs its
    // OWN agent (去借壳, agentOverrideName null); DESIGNER (the origin) has NO pending run.
    expect((await designerEntries(db, taskId))[0]?.dispatchedAt).not.toBeNull()
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBeNull()
    const otherPending = (
      await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    ).find((r) => r.id === runId && r.status === 'pending')
    expect(otherPending).toBeDefined()
    expect(otherPending?.agentOverrideName).toBeNull() // 去借壳: OTHER runs its own agent
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.some((r) => r.status === 'pending')).toBe(false) // no mint on the origin

    // The TARGET OTHER's rerun binds its per-node queue (keyed by effectiveTarget=OTHER).
    await bindTriggerRun(db, [(await designerEntries(db, taskId))[0]!.id], runId)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId) // bound at rerun
  })

  test('never-run reassign target → REJECTED (去借壳: the rerun mints ON the target, which has no prior run to inherit)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has NO prior node_run.
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it to OTHER.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    // reassign to a NEVER-RUN node — canReassign accepts it, but dispatch is run-gated.
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    // RFC-127 借壳 could mint on the origin DESIGNER (which HAS a run), so a never-run borrow target
    // dispatched fine. RFC-131 T4 去借壳 REVERSES that: the rerun is minted ON the effective target
    // OTHER — which never ran → no prior node_run to inherit → REJECTED (safe first-run minting for a
    // never-run frontier target is the deferred F3 layer). Nothing stamped, nothing minted.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-unsafe-dispatch-target')
    expect((await designerEntries(db, taskId))[0]?.dispatchedAt).toBeNull() // nothing stamped
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0) // nothing minted
  })

  test('per-node queue is authoritative for deferred (去借壳): the TARGET injects the reassigned question (mint on target, own agent); the origin designer has no queue', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it to OTHER.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    // RFC-131 T4 去借壳: effectiveTarget=OTHER is the frontier — mint OTHER running its OWN agent.
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER)
    const targetRunId = result.reruns[0]!.nodeRunId
    const targetRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, targetRunId)))[0]
    expect(targetRun?.agentOverrideName).toBeNull() // 去借壳: OTHER runs its own agent

    // The ORIGIN DESIGNER is no longer the effective target (the entry moved to OTHER); the
    // TARGET OTHER's rerun binds the reassigned entry to its own run.
    await bindTriggerRun(db, [(await designerEntries(db, taskId))[0]!.id], targetRunId)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(targetRunId)
  })
})

// ---------------------------------------------------------------------------
// F — Codex impl-gate folds on the run-scoped layer: H1 (split-round per-origin),
// M1 (override target gets no Update Directive), H2 (the HTTP release path).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — run-scoped layer Codex folds (H1/M1/H2)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }
  const TOKEN = 'a'.repeat(64)
  const AUTH = { Authorization: `Bearer ${TOKEN}` }

  function makeApp(db: DbClient) {
    process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-t9-home-'))
    return createApp({
      token: TOKEN,
      configPath: join(mkdtempSync(join(tmpdir(), 'aw-t9-cfg-')), 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
  }

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  test('H1: a round split q1→override / q2→graph-designer is REJECTED per-origin (nothing stamped/minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives designers. Build the split directly — q1's designer on
    // OTHER, q2's on DESIGNER (different handler nodes, SAME origin round → a multi-target round).
    const questioners = await db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'questioner')))
    await reassignTaskQuestion(db, questioners.find((e) => e.questionId === 'q1')!.id, OTHER, actor)
    await reassignTaskQuestion(
      db,
      questioners.find((e) => e.questionId === 'q2')!.id,
      DESIGNER,
      actor,
    )
    const entries = await designerEntries(db, taskId)
    const q1Entry = entries.find((e) => e.questionId === 'q1')!

    // dispatching q1 must be rejected: the per-origin guard sees q2 (→ DESIGNER) in the SAME
    // round targeting a different handler node, even though q2 is outside the requested group.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [q1Entry.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-round-multi-target')
    // nothing stamped, nothing minted (no partial dispatch)
    const after = await designerEntries(db, taskId)
    expect(after.every((e) => e.triggerRunId === null)).toBe(true)
    const minted = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(minted.length).toBe(0)
  })

  test('M1: the override handoff mints the rerun ON the target (RFC-141: no Update-Directive suppression anymore)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it to OTHER.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor)
    // RFC-131 T4 去借壳: the rerun is minted ON the target OTHER. (RFC-141 removed the run-scoped
    // Update-Directive suppression this used to drive — OTHER now also sees its own prior output.)
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER)
  })

  test('M1→RFC-141: the generic priorOutputUpdate is NO LONGER suppressed for an override handoff (source lock)', () => {
    // The giant runOneNode prompt assembly can't be unit-run (it spawns opencode);
    // lock at the source so a revert that re-adds the RFC-120 §18 gate goes red.
    // RFC-141 (user ruling): an override target sees its own prior output as background — the
    // reassigned Q&A rides `## Clarify Q&A`, and the directive's "feedback above" points at it.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')
    expect(src).not.toContain('clarifyQueue?.suppressPriorOutput')
    expect(src).not.toContain('!suppressPriorOutput')
  })

  test('H2: full HTTP path — deferred submit parks, POST .../questions/dispatch stamps + mints + releases the gate', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    // owner = the daemon TOKEN actor (__system__) so the member gate passes.
    const { taskId, intermediaryNodeRunId } = await seedTask(db, {
      deferred: true,
      ownerUserId: '__system__',
    })
    // designer-scoped control seal → parked (entry created, no rerun); simulate the park.
    const sealed = await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(sealed.roundFullySealed).toBe(true)
    // RFC-162: add the undispatched designer entry that parks the task (reconcile no longer
    // derives it from scope) — the HTTP dispatch below then stamps + mints + releases it.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(1) // parked

    const entry = (await designerEntries(db, taskId))[0]!
    const res = await app.request(`/api/tasks/${taskId}/questions/dispatch`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ entryIds: [entry.id] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; reruns: Array<{ nodeRunId: string }> }
    expect(body.ok).toBe(true)
    expect(body.reruns.length).toBe(1)

    // entry committed (dispatched_at) + a pending designer frontier rerun + gate released.
    // trigger_run_id is NOT stamped at dispatch (the scheduler binds it at the rerun).
    const dispatchedEntry = (await designerEntries(db, taskId))[0]
    expect(dispatchedEntry?.dispatchedAt).not.toBeNull()
    expect(dispatchedEntry?.triggerRunId).toBeNull()
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(pending.length).toBe(1)
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0) // released
  })

  test('H2: dispatch route rejects empty entryIds (422)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    const { taskId } = await seedTask(db, { deferred: true, ownerUserId: '__system__' })
    const res = await app.request(`/api/tasks/${taskId}/questions/dispatch`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ entryIds: [] }),
    })
    expect(res.status).toBe(422)
  })

  // RFC-132 PR-B (universal deferred model): the H1 re-gate ('dispatch rejects a NON-deferred task')
  // is REMOVED. Every task dispatches through the ONE unified path (route → autoDispatchClarifyRound
  // → dispatchTaskQuestions); the `deferredQuestionDispatch` flag is vestigial. Double-mint is now
  // prevented by the SINGLE path (an already-dispatched entry is a no-op), not by a flag gate.
  test('PR-B: the unified quick channel dispatches the designer on any task — exactly one rerun, no double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: false })
    // The unified quick channel seals + auto-dispatches the QUESTIONER (autoDispatch never
    // auto-dispatches designers — they ride the board's 批量下发, RFC-162 reconcile derives none).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      actor,
    })
    // RFC-162: the designer handler is ADDED by a reassign, then dispatched through the SAME
    // unified dispatchTaskQuestions the board uses — exactly one rerun, no double-mint.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    // the designer entry is dispatched (stamped) → the designer rerun minted EXACTLY once.
    expect((await designerEntries(db, taskId))[0]?.dispatchedAt).not.toBeNull()
    const designerReruns = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.rerunCause, 'cross-clarify-answer'),
        ),
      )
    expect(designerReruns.length).toBe(1)
    // a naive re-dispatch of the already-dispatched entry is a no-op (no double-mint) — the single
    // path's own in-flight/dispatched gate, not a deferred-flag rejection.
    const before = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    expect(after).toBe(before)
  })

  test('read-side phase: pending→staged pre-dispatch, processing (dispatched, queued) → awaiting_confirm after the run BINDS + finishes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const phaseOf = async () =>
      (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!.phase

    // Pre-dispatch: NOT processing — the task is parked, the row is pending.
    expect(await phaseOf()).toBe('pending')
    const entry = (await designerEntries(db, taskId))[0]!
    await stageTaskQuestion(db, entry.id, true, actor)
    expect(await phaseOf()).toBe('staged')

    // Dispatch → dispatched_at set, trigger_run_id still NULL (queued) → processing.
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const runId = result.reruns[0]!.nodeRunId
    expect(await phaseOf()).toBe('processing')

    await bindTriggerRun(db, [entry.id], runId)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
    expect(await phaseOf()).toBe('processing') // bound, but run not done yet

    // Run finishes done + output → awaiting_confirm.
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
    await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'result', content: 'x' })
    expect(await phaseOf()).toBe('awaiting_confirm')
  })

  test('M1(re-gate): reassign allowed pre-dispatch (NULL trigger) but rejected post-dispatch (stamped)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!

    // pre-dispatch (dispatched_at NULL) → reassign allowed; RFC-162 re-targets the designer
    // row's defaultTargetNodeId (override stays null).
    await reassignTaskQuestion(db, entry.id, OTHER, actor)
    expect((await designerEntries(db, taskId))[0]?.defaultTargetNodeId).toBe(OTHER)

    // dispatch stamps trigger_run_id.
    await dispatchTaskQuestions(db, taskId, [entry.id], actor)

    // post-dispatch → reassign rejected (reopen is the post-dispatch path).
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, entry.id, DESIGNER, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-already-dispatched')
  })

  test('H1(final): a process-retry of the dispatched run resolves awaiting_confirm (not stuck on the failed anchor); confirm works', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const anchorRunId = result.reruns[0]!.nodeRunId
    const anchorRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, anchorRunId)))[0]!

    await bindTriggerRun(db, [entry.id], anchorRunId)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(anchorRunId)

    const phaseOf = async () =>
      (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!.phase

    // The bound run FAILS → still processing (D3), confirm would reject.
    await db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, anchorRunId))
    expect(await phaseOf()).toBe('processing')

    // The scheduler mints a technical process-retry (same node + iteration, cause
    // 'process-retry', fresh ULID > anchor) which succeeds with output.
    const retryId = ulid()
    await db.insert(nodeRuns).values({
      id: retryId,
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 1,
      iteration: anchorRow.iteration,
      rerunCause: 'process-retry',
      startedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({ nodeRunId: retryId, portName: 'result', content: 'x' })

    // The entry resolves through the LINEAGE → awaiting_confirm (not stuck).
    expect(await phaseOf()).toBe('awaiting_confirm')
    // confirm now works.
    await confirmTaskQuestion(db, entry.id, actor)
    expect(await phaseOf()).toBe('done')
  })

  test('H2(re-gate): a fresh process-retry STILL carries the External Feedback (lineage select, not == run id)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const attempt1 = result.reruns[0]!.nodeRunId
    const a1Row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, attempt1)))[0]!

    await bindTriggerRun(db, [entry.id], attempt1)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(attempt1)
    await db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, attempt1))

    // The scheduler mints a FRESH process-retry (different id, same node+iteration).
    const attempt2 = ulid()
    await db.insert(nodeRuns).values({
      id: attempt2,
      taskId,
      nodeId: DESIGNER,
      status: 'pending',
      retryIndex: 1,
      iteration: a1Row.iteration,
      rerunCause: 'process-retry',
      startedAt: null,
    })

    // Codex H2 re-gate: the retry's rerun REBINDS the question to attempt2 (the unified queue
    // injector's lineage-select rebind — trigger_run_id follows the fresh process-retry).
    await bindTriggerRun(db, [entry.id], attempt2)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(attempt2)
  })

  test('H3(re-gate): a mixed {default-to-D, override-to-D} batch STILL gates on D readiness (unresolved sibling → rejected, nothing minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // D has two sibling cross-clarify sources (cc_a, cc_b → D); E has its own (cc_c → E).
    const D = 'designer'
    const E = 'designerE'
    const nodes: WorkflowNode[] = [
      { id: D, kind: 'agent-single', agentName: 'd' } as WorkflowNode,
      { id: E, kind: 'agent-single', agentName: 'e' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'qa' } as WorkflowNode,
      { id: 'q_b', kind: 'agent-single', agentName: 'qb' } as WorkflowNode,
      { id: 'q_c', kind: 'agent-single', agentName: 'qc' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
      { id: 'cc_c', kind: 'clarify-cross-agent', title: 'cc_c' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = []
    for (const { q, cc, d } of [
      { q: 'q_a', cc: 'cc_a', d: D },
      { q: 'q_b', cc: 'cc_b', d: D },
      { q: 'q_c', cc: 'cc_c', d: E },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: d, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'h3',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'h3',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-h3/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    for (const n of [D, E]) {
      await db
        .insert(nodeRuns)
        .values({ id: ulid(), taskId, nodeId: n, status: 'done', retryIndex: 0, iteration: 0 })
    }
    const openSession = async (q: string, cc: string, d: string, qid: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: cc,
        askingNodeId: q,
        askingNodeRunId: runId,
        targetConsumerNodeId: d,
        loopIter: 0,
        questions: [mkQ(qid, 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await openSession('q_a', 'cc_a', D, 'a1')
    await openSession('q_b', 'cc_b', D, 'b1') // cc_b stays awaiting_human (unresolved sibling)
    const ccC = await openSession('q_c', 'cc_c', E, 'c1')

    // Answer cc_a (→ D default entry) and cc_c (→ E default entry). cc_b is NOT answered.
    await sealRoundQuestions({
      db,
      originNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: ccC,
      answers: [ans('c1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives designers — add one per source (cc_a → D, cc_c → E).
    await seedDesignerEntries(db, taskId, D, actor, { originNodeRunId: ccA })
    await seedDesignerEntries(db, taskId, E, actor, { originNodeRunId: ccC })
    const all = await designerEntries(db, taskId)
    const entryA = all.find((e) => e.defaultTargetNodeId === D)! // default-to-D
    const entryC = all.find((e) => e.defaultTargetNodeId === E)! // default-to-E
    await reassignTaskQuestion(db, entryC.id, D, actor) // re-target entryC → D (its designer row moves to D)

    // The batch's group for D = {entryA (cc_a), entryC (re-targeted from E)}. Both are now
    // default-to-D designer rows — the readiness gate must NOT be skipped: D's graph subset
    // {entryA, entryC} still gates on cc_b (D's unresolved sibling cross-clarify round).
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id, entryC.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-designer-not-ready')
    // Nothing minted, nothing stamped (no partial dispatch).
    expect((await designerEntries(db, taskId)).every((e) => e.dispatchedAt === null)).toBe(true)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0)
  })

  test('H2(re-gate): a NON-frontier affected graph designer is readiness-gated too — unresolved sibling → whole dispatch rejected, nothing stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // A --(dataflow)--> B. A is a graph designer (cc_a → A); B is a graph designer with TWO
    // sibling cross-clarify sources (cc_b1, cc_b2 → B). A is the frontier (upstream of B);
    // B is NON-frontier (cascade). cc_b2 is left unresolved.
    const A = 'designer'
    const B = 'designerB'
    const nodes: WorkflowNode[] = [
      { id: A, kind: 'agent-single', agentName: 'a' } as WorkflowNode,
      { id: B, kind: 'agent-single', agentName: 'b' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'qa' } as WorkflowNode,
      { id: 'q_b1', kind: 'agent-single', agentName: 'qb1' } as WorkflowNode,
      { id: 'q_b2', kind: 'agent-single', agentName: 'qb2' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b1', kind: 'clarify-cross-agent', title: 'cc_b1' } as WorkflowNode,
      { id: 'cc_b2', kind: 'clarify-cross-agent', title: 'cc_b2' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = [
      // A --(real dataflow edge)--> B → A is a transitive ancestor of B (A frontier, B not).
      {
        id: 'e_a_b',
        source: { nodeId: A, portName: 'result' },
        target: { nodeId: B, portName: 'input' },
      },
    ]
    for (const { q, cc, d } of [
      { q: 'q_a', cc: 'cc_a', d: A },
      { q: 'q_b1', cc: 'cc_b1', d: B },
      { q: 'q_b2', cc: 'cc_b2', d: B },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: d, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'h2ng',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'h2ng',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-h2ng/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    for (const n of [A, B]) {
      await db
        .insert(nodeRuns)
        .values({ id: ulid(), taskId, nodeId: n, status: 'done', retryIndex: 0, iteration: 0 })
    }
    const openSession = async (q: string, cc: string, d: string, qid: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: cc,
        askingNodeId: q,
        askingNodeRunId: runId,
        targetConsumerNodeId: d,
        loopIter: 0,
        questions: [mkQ(qid, 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await openSession('q_a', 'cc_a', A, 'a1')
    const ccB1 = await openSession('q_b1', 'cc_b1', B, 'b1')
    await openSession('q_b2', 'cc_b2', B, 'b2') // cc_b2 stays awaiting_human (unresolved)

    // Answer cc_a (→ A entry) and cc_b1 (→ B entry). cc_b2 is left unresolved.
    await sealRoundQuestions({
      db,
      originNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: ccB1,
      answers: [ans('b1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives designers — add one per source (cc_a → A, cc_b1 → B).
    await seedDesignerEntries(db, taskId, A, actor, { originNodeRunId: ccA })
    await seedDesignerEntries(db, taskId, B, actor, { originNodeRunId: ccB1 })
    const all = await designerEntries(db, taskId)
    const entryA = all.find((e) => e.defaultTargetNodeId === A)!
    const entryB = all.find((e) => e.defaultTargetNodeId === B)!

    // Dispatch BOTH. B is NON-frontier (A is its dataflow ancestor) but is still a graph
    // designer with an unresolved sibling (cc_b2) → readiness must gate it, so the WHOLE
    // dispatch is rejected before stamping anything.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id, entryB.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-designer-not-ready')
    expect((await designerEntries(db, taskId)).every((e) => e.dispatchedAt === null)).toBe(true)
    const pendingRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pendingRuns.length).toBe(0)

    // Once cc_b2 is answered, the same dispatch succeeds (A frontier; B left for cascade).
    const ccB2Run = (
      await db
        .select()
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.intermediaryNodeId, 'cc_b2')))
    )[0]!.intermediaryNodeRunId
    await sealRoundQuestions({
      db,
      originNodeRunId: ccB2Run,
      answers: [ans('b2')],
      directive: 'continue',
    })
    // Now both of B's siblings are resolved → the same dispatch succeeds (A frontier; B left
    // for the scheduler cascade). entryA/entryB ids are stable (reconcile is idempotent).
    const result = await dispatchTaskQuestions(db, taskId, [entryA.id, entryB.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(A) // only the frontier minted
  })

  test('H2(final): reassign is a CAS on dispatched_at — a concurrent dispatch makes it affect 0 rows → rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    // Simulate a dispatch winning the race (stamping dispatched_at) AFTER reassign
    // would have read a NULL — the reassign CAS (WHERE dispatched_at IS NULL) then
    // affects 0 rows → reject (no silent re-target of committed work).
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now() })
      .where(eq(taskQuestions.id, entry.id))
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, entry.id, OTHER, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-already-dispatched')
    // target unchanged (the CAS did not write): the designer row still points at DESIGNER,
    // override still null (RFC-162 reassign re-targets defaultTargetNodeId, which never moved).
    expect((await designerEntries(db, taskId))[0]?.defaultTargetNodeId).toBe(DESIGNER)
    expect((await designerEntries(db, taskId))[0]?.overrideTargetNodeId).toBeNull()
  })

  test('H3(final): graph-designer dispatch is rejected while a sibling cross-clarify is still awaiting; succeeds once answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, ccA, ccB } = await seedTwoSource(db)

    // Answer source A (designer-scoped, control seal) → parked. B is still awaiting_human.
    const subA = await sealRoundQuestions({
      db,
      originNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    expect(subA.roundFullySealed).toBe(true)
    // RFC-162: reconcile no longer derives a designer entry from scope — add one for source A
    // (→ DESIGNER, the shared graph designer of both cc_a and cc_b).
    await seedDesignerEntries(db, taskId, DESIGNER, actor, { originNodeRunId: ccA })
    const entryA = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccA)!

    // Dispatch A's designer entry → rejected: sibling B unresolved → partial rerun risk.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-designer-not-ready')
    expect((await designerEntries(db, taskId)).every((e) => e.triggerRunId === null)).toBe(true)

    // Answer source B → now all siblings resolved.
    await sealRoundQuestions({
      db,
      originNodeRunId: ccB,
      answers: [ans('b1')],
      directive: 'continue',
    })
    // Dispatch now succeeds (one designer rerun for the full batch).
    const result = await dispatchTaskQuestions(db, taskId, [entryA.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
  })

  test('per-node queue (final): two graph designers each carry their OWN source only — NO C1 exclusion needed', async () => {
    // RFC-127 借壳: pre-127 this split one round to an OVERRIDE node (fixer) and kept the other on
    // the graph designer → two homes → two mints. Under 借壳 an override no longer moves the home,
    // so two {override, default} entries sharing ONE default would collapse onto a single home and
    // hit the per-home single-borrow gate. To preserve the dual-frontier / independent-queue intent
    // we use TWO distinct graph designer nodes (different defaults → two homes → two mints).
    const db = createInMemoryDb(MIGRATIONS)
    const D1 = 'designer'
    const D2 = 'designer2'
    const nodes: WorkflowNode[] = [
      { id: D1, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: D2, kind: 'agent-single', agentName: 'designer2' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
      { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = []
    for (const { q, cc, d } of [
      { q: 'q_a', cc: 'cc_a', d: D1 },
      { q: 'q_b', cc: 'cc_b', d: D2 },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: d, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'two-designer',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'two-designer',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-two-designer/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    for (const n of [D1, D2]) {
      await db
        .insert(nodeRuns)
        .values({ id: ulid(), taskId, nodeId: n, status: 'done', retryIndex: 0, iteration: 0 })
    }
    const open = async (q: string, cc: string, d: string, qid: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: cc,
        askingNodeId: q,
        askingNodeRunId: runId,
        targetConsumerNodeId: d,
        loopIter: 0,
        questions: [mkQ(qid, 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await open('q_a', 'cc_a', D1, 'a1')
    const ccB = await open('q_b', 'cc_b', D2, 'b1')
    await sealRoundQuestions({
      db,
      originNodeRunId: ccA,
      answers: [{ ...ans('a1'), selectedOptionLabels: ['AAA'] }],
      directive: 'continue',
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: ccB,
      answers: [{ ...ans('b1'), selectedOptionLabels: ['BBB'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives designers — add one per source (cc_a → D1, cc_b → D2).
    await seedDesignerEntries(db, taskId, D1, actor, { originNodeRunId: ccA })
    await seedDesignerEntries(db, taskId, D2, actor, { originNodeRunId: ccB })
    const entryA = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccA)!
    const entryB = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccB)!

    // Two distinct graph designers → two homes → two independent frontier mints (no borrow).
    const dispA = await dispatchTaskQuestions(db, taskId, [entryA.id], actor)
    const dispB = await dispatchTaskQuestions(db, taskId, [entryB.id], actor)
    expect(dispA.reruns[0]?.targetNodeId).toBe(D1)
    expect(dispB.reruns[0]?.targetNodeId).toBe(D2)

    // D1's queue carries q_a ONLY — q_b lives on D2's own queue, so it is simply ABSENT from D1
    // (no exclusion logic — RFC-120 §18.3).
  })

  test('H2(final): a directive=stop designer-scoped round never creates a deferred park', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    // A REJECT (directive='stop') round — intentionally skips the designer rerun; the unified
    // quick channel still reruns the QUESTIONER (stop) via dispatch.
    const submit = await autoDispatchClarifyRound({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [ans('q1')],
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    expect(submit.dispatch.reruns.some((r) => r.targetNodeId === QUESTIONER)).toBe(true)
    expect(submit.dispatch.reruns.some((r) => r.targetNodeId === DESIGNER)).toBe(false)

    // Lazy reconcile (listTaskQuestions) must NOT mint a designer entry for a stop
    // round → no eternal park. (The questioner entry is still created.)
    const list = await listTaskQuestions(db, taskId)
    expect(list.some((e) => e.roleKind === 'questioner')).toBe(true)
    expect(list.some((e) => e.roleKind === 'designer')).toBe(false)
    expect((await designerEntries(db, taskId)).length).toBe(0)
    // The deferred gate stays EMPTY — the task does not get stuck awaiting_human.
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// G — RFC-120 §18 corrected model: UPSTREAM-FRONTIER mint + per-node queue +
// per-question consumption. A (graph designer DESIGNER) feeds (dataflow edge) into B
// (DOWN). A round's designer question stays at A (cc_a → DESIGNER default); a second
// round's designer question DEFAULTS to B (cc_b → DOWN default). RFC-127 借壳 retired the
// old override-to-DOWN here: under 借壳 an override no longer moves the home, so a
// {default DESIGNER, override DOWN} entry would collapse onto DESIGNER's home alongside A
// and hit the per-home single-borrow gate — distinct DEFAULT designers (DESIGNER vs DOWN)
// preserve the A→B frontier + cascade semantics. Dispatch mints ONLY the frontier A; the
// scheduler cascade (RFC-074 provenance freshness) re-dispatches B against A's fresh
// output, and B drains ITS queue at rerun.
// ---------------------------------------------------------------------------
describe('RFC-120 §18 — frontier mint + per-node queue + consumption', () => {
  const actor = { userId: 'u1', role: 'owner' as const }
  const DOWN = 'down'

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  /** Seed a deferred task: DESIGNER --(dataflow)--> DOWN, two cross-clarify sources —
   *  cc_a/q_a → DESIGNER (default), cc_b/q_b → DOWN (default; RFC-127 借壳 — was an
   *  override-to-DOWN). DESIGNER + DOWN each have a prior `done` run (DOWN's draft consumes
   *  DESIGNER's done — so a DESIGNER rerun demotes DOWN, RFC-074). */
  async function seedFrontierChain(db: DbClient): Promise<{
    taskId: string
    ccA: string
    ccB: string
    def: WorkflowDefinition
    designerDoneId: string
    downDoneId: string
  }> {
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    const nodes: WorkflowNode[] = [
      { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: DOWN, kind: 'agent-single', agentName: 'down' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
      { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = [
      // DESIGNER --(real dataflow edge)--> DOWN: makes DESIGNER a transitive ancestor of DOWN.
      {
        id: 'e_d_down',
        source: { nodeId: DESIGNER, portName: 'result' },
        target: { nodeId: DOWN, portName: 'input' },
      },
    ]
    for (const { q, cc, d } of [
      { q: 'q_a', cc: 'cc_a', d: DESIGNER },
      // RFC-127 借壳: cc_b targets DOWN as its DEFAULT designer (distinct home from A).
      { q: 'q_b', cc: 'cc_b', d: DOWN },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: d, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'rfc120-frontier',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc120-frontier',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-rfc120-frontier/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    const designerDoneId = ulid()
    await db.insert(nodeRuns).values({
      id: designerDoneId,
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const downDoneId = ulid()
    await db.insert(nodeRuns).values({
      id: downDoneId,
      taskId,
      nodeId: DOWN,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      // DOWN consumed DESIGNER's done → a DESIGNER rerun makes this draft stale (RFC-074).
      consumedUpstreamRunsJson: JSON.stringify({ [DESIGNER]: designerDoneId }),
    })
    const open = async (q: string, cc: string, d: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: cc,
        askingNodeId: q,
        askingNodeRunId: runId,
        targetConsumerNodeId: d,
        loopIter: 0,
        questions: [mkQ(cc === 'cc_a' ? 'a1' : 'b1', 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await open('q_a', 'cc_a', DESIGNER)
    const ccB = await open('q_b', 'cc_b', DOWN)
    return { taskId, ccA, ccB, def, designerDoneId, downDoneId }
  }

  /** Answer both sources (designer-scoped, deferred), dispatch both. RFC-127 借壳: cc_b's DEFAULT
   *  designer is already DOWN (the seed wires cc_b → DOWN) — no override needed; entryA's home is
   *  DESIGNER, entryB's home is DOWN. Returns the dispatch result + the two entries. */
  async function answerAndDispatch(db: DbClient) {
    const seed = await seedFrontierChain(db)
    await sealRoundQuestions({
      db,
      originNodeRunId: seed.ccA,
      answers: [{ ...ans('a1'), selectedOptionLabels: ['AAA'] }],
      directive: 'continue',
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: seed.ccB,
      answers: [{ ...ans('b1'), selectedOptionLabels: ['BBB'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives designers — add one per source (cc_a → DESIGNER,
    // cc_b → DOWN), reproducing the seed's default-designer wiring (frontier A upstream of B).
    await seedDesignerEntries(db, seed.taskId, DESIGNER, actor, { originNodeRunId: seed.ccA })
    await seedDesignerEntries(db, seed.taskId, DOWN, actor, { originNodeRunId: seed.ccB })
    const entryA = (await designerEntries(db, seed.taskId)).find(
      (e) => e.originNodeRunId === seed.ccA,
    )!
    const entryB = (await designerEntries(db, seed.taskId)).find(
      (e) => e.originNodeRunId === seed.ccB,
    )!
    const result = await dispatchTaskQuestions(db, seed.taskId, [entryA.id, entryB.id], actor)
    return { seed, entryA, entryB, result }
  }

  test('FRONTIER: A upstream of B, both have dispatched designer questions → dispatch mints ONLY A (zero on B)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { seed, result } = await answerAndDispatch(db)

    // Exactly ONE frontier rerun — on A (DESIGNER). B (DOWN) is left for the cascade.
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    expect(result.dispatchedEntryIds.length).toBe(2) // BOTH entries committed for execution

    // ZERO pending runs minted on DOWN by dispatch (it is NOT the frontier).
    const downRuns = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, seed.taskId),
          eq(nodeRuns.nodeId, DOWN),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(downRuns.length).toBe(0)
    // Exactly ONE pending rerun on DESIGNER.
    const designerPending = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, seed.taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(designerPending.length).toBe(1)
    // Both entries committed → the park gate is fully released.
    expect((await designerEntries(db, seed.taskId)).every((e) => e.dispatchedAt !== null)).toBe(
      true,
    )
    expect((await loadUndispatchedDesignerTargets(db, seed.taskId)).size).toBe(0)
  })

  test('cascade: once A reruns fresh, deriveFrontier re-dispatches the downstream B (B minted by the SCHEDULER, not dispatch)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { seed } = await answerAndDispatch(db)
    // Simulate A's frontier rerun completing FRESH (a new done id > the old draft id).
    const designerRerunDone = ulid()
    await db
      .update(nodeRuns)
      .set({ status: 'done' })
      .where(
        and(
          eq(nodeRuns.taskId, seed.taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    // (the pending rerun is now done; its ULID is later than designerDoneId → freshest)
    void designerRerunDone

    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, seed.taskId))
    const scopeNodes = seed.def.nodes as unknown as WorkflowNode[]
    // BOTH entries are dispatched (dispatched_at set) → NEITHER node is in the deferred
    // park set anymore; DOWN is re-dispatched purely by RFC-074 freshness (its draft
    // consumed DESIGNER's OLD run → stale once DESIGNER reran).
    const deferred = await loadUndispatchedDesignerTargets(db, seed.taskId)
    expect(deferred.size).toBe(0)
    const f = deriveFrontier(
      rows,
      seed.def,
      scopeNodes,
      new Set(scopeNodes.map((n) => n.id)),
      0,
      new Map([[DOWN, [DESIGNER]]]),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      deferred,
    )
    // DESIGNER's fresh done is a completion; DOWN's stale draft is re-dispatched (ready).
    expect(f.completed.has(DESIGNER)).toBe(true)
    expect(f.ready).toContain(DOWN)
  })

  test("PER-NODE QUEUE: B's rerun injects + binds B's OWN question's answer (bound at the rerun, not at dispatch)", async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { seed, entryB } = await answerAndDispatch(db)
    // The cascade mints DOWN's rerun (a fresh pending run on DOWN).
    const downRerunId = ulid()
    await db.insert(nodeRuns).values({
      id: downRerunId,
      taskId: seed.taskId,
      nodeId: DOWN,
      status: 'pending',
      retryIndex: 1,
      iteration: 0,
      rerunCause: 'cross-clarify-answer',
    })

    // Pre-rerun: entryB committed (dispatched_at) but NOT bound (trigger_run_id NULL).
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryB.id)))[0]
        ?.triggerRunId,
    ).toBeNull()

    // DOWN's rerun binds entryB to its own run (the unified queue injector stamps trigger_run_id).
    await bindTriggerRun(db, [entryB.id], downRerunId)
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryB.id)))[0]
        ?.triggerRunId,
    ).toBe(downRerunId)
  })

  test("CONSUMPTION: A done+output → only A's bound question leaves the queue; B's (downstream) question is untouched", async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { seed, entryA, entryB } = await answerAndDispatch(db)
    const designerRerunId = (
      await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, seed.taskId),
            eq(nodeRuns.nodeId, DESIGNER),
            eq(nodeRuns.status, 'pending'),
          ),
        )
    )[0]!.id

    // A's rerun binds A's queue (entryA → DESIGNER). entryB (override → DOWN) is NOT in it.
    await bindTriggerRun(db, [entryA.id], designerRerunId)
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryA.id)))[0]
        ?.triggerRunId,
    ).toBe(designerRerunId)
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryB.id)))[0]
        ?.triggerRunId,
    ).toBeNull()

    // A's run finishes done + output → ledger consumption (does NOT over-consume B): the
    // derived-aging queue selection per node is covered by rfc132-select-agent-queue.
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, designerRerunId))
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: designerRerunId, portName: 'result', content: 'x' })
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryB.id)))[0]
        ?.triggerRunId,
    ).toBeNull() // B (override → DOWN) was never bound to A's DESIGNER rerun
  })
})

// ---------------------------------------------------------------------------
// H — prior output on override handoffs. HISTORY: RFC-120 §18 ownership-gated the
// prior-output directive (graphOwned → suppressPriorOutput on the RFC-132 flat queue) so a
// pure-override target would process the reassigned question instead of rewriting its own
// artifact. RFC-141 (user ruling) REMOVED that suppression: the override target now sees its
// own prior output as background, and the reassigned Q&A rides `## Clarify Q&A`. These tests
// lock the new shape: the flat queue context builds for both handoff forms and carries NO
// suppress signal. (The xcc render pair below is the legacy cross-clarify path — unchanged.)
// ---------------------------------------------------------------------------
describe('RFC-120 §18 → RFC-141 — prior output on override handoffs (deferred)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  test('RFC-141: a reassigned handoff builds the flat queue context WITHOUT any suppress signal (prior output injects)', async () => {
    // HISTORY: RFC-131 T4 去借壳 moved the rerun to the target OTHER, and RFC-120 §18 flagged this
    // shape suppressPriorOutput=true (OTHER must not be told to update its own artifact). RFC-141
    // removed the flag — OTHER now gets its own prior output as background; this test locks that
    // the context still builds and the suppress member is gone at runtime.
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: add the designer handler (default DESIGNER) via reassign, then re-target it to OTHER.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // default DESIGNER, reassigned to OTHER (run moves)
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER) // 去借壳: run minted ON the target OTHER
    // Production dispatches a SEALED designer entry (stage gate) — reflect that so the unified queue
    // injector selects it.
    await db
      .update(taskQuestions)
      .set({ sealedAt: Date.now() })
      .where(eq(taskQuestions.id, entry.id))
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: OTHER,
      dispatchedRunId: result.reruns[0]!.nodeRunId,
      iteration: 0,
    })
    // the reassigned Q&A still injects…
    expect(ctx).toBeDefined()
    expect(ctx!.block.length).toBeGreaterThan(0)
    // …and the RFC-120 §18 suppress member is gone (runtime lock backing the type-level removal).
    expect(Object.keys(ctx!)).not.toContain('suppressPriorOutput')
  })

  test('RFC-141: a genuine graph-designer round builds the same suppress-free context (both handoff shapes uniform)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, intermediaryNodeRunId } = await seedTask(db, { deferred: true })
    await sealRoundQuestions({
      db,
      originNodeRunId: intermediaryNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // RFC-162: reconcile no longer derives a designer entry from scope — add one via reassign.
    await seedDesignerEntries(db, taskId, DESIGNER, actor)
    const entry = (await designerEntries(db, taskId))[0]!
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    // Production dispatches a SEALED designer entry (stage gate). A genuine graph designer used to
    // be the suppressPriorOutput=false shape; RFC-141 removed the member for BOTH shapes.
    await db
      .update(taskQuestions)
      .set({ sealedAt: Date.now() })
      .where(eq(taskQuestions.id, entry.id))
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: DESIGNER,
      dispatchedRunId: result.reruns[0]!.nodeRunId,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block.length).toBeGreaterThan(0)
    expect(Object.keys(ctx!)).not.toContain('suppressPriorOutput')
  })

  // RFC-148 (RFC-132 收尾): the crossClarifyContext render path is DELETED —
  // designer Q&A rides the flat clarify block; prior output rides
  // priorOutputUpdate. The two render cases that exercised the dead path are
  // replaced by a negative lock: the dead surface must not come back.
  test('render: the External Feedback dead path stays dead (RFC-148)', () => {
    const promptSrc = readFileSync(
      join(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts'),
      'utf8',
    )
    expect(promptSrc).not.toContain('crossClarifyContext')
    expect(promptSrc).not.toContain('## External Feedback')
  })

  test('source lock: the scheduler no longer gates prior-output on ANY ownership signal (RFC-141)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')
    // RFC-132 (PR-C) replaced the cross-clarify graphOwned attach gate with the flat queue's
    // suppressPriorOutput; RFC-141 removed that too. Negative locks so neither gate re-grows.
    expect(src).not.toContain('crossClarifyContext?.graphOwned')
    expect(src).not.toContain('clarifyQueue?.suppressPriorOutput')
    expect(src).not.toContain('!suppressPriorOutput')
  })
})
