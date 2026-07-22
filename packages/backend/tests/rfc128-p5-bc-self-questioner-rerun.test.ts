// RFC-128 P5-BC — self/questioner per-question rerun (深度重构核心；最高风险段)。
//
// This locks the P5-BC clean-path (design.md §5.2): the self/questioner MIRROR of the designer
// per-question infrastructure. It covers the §5.2.4 self-checks + the five dispatch contracts
// (§5.2.11 readiness gate / §5.2.12 rerun-cause + collapse 推翻 + in-flight gate 扩域 / §5.2.13
// mixed-role grouping + auto-split) + the §5.2.5 double-injection root-out.
//
// RFC-132 §8 update: the legacy immediate quick channel (whole-round submit) is DELETED — the
// unified autoDispatchClarifyRound is the only quick path. The §5.2.6 whole-round byte-for-byte
// golden locks and the quick-channel-only semantics locks (quick-finalize reject/consume, the
// legacy submit-side source-order locks) were deleted with it; mixed-flow equivalents live in
// rfc128-p5-d-autodispatch.test.ts. Immediate-LEDGER states (a pending continuation with no
// dispatched entry) survive below as HAND-SEEDED pre-upgrade leftovers — the dispatch gate must
// keep protecting them through the migration window.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { readFileSync } from 'node:fs'
import { dispatchTaskQuestions, resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import {
  loadUndispatchedSelfQuestionerTargets,
  reconcileTaskQuestionsForRound,
} from '../src/services/taskQuestions'
import { createClarifyRound } from '../src/services/clarify/service'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { getTaskQuestionWriteSem, getTaskWriteSem } from '../src/services/taskWriteLocks'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const P = 'P' // self-asking agent + a borrow home
const Q = 'Q' // cross questioner agent
const D = 'D' // cross designer agent
const X = 'X' // borrow target
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: P, kind: 'agent-single', agentName: 'agent-p' } as WorkflowNode,
    { id: Q, kind: 'agent-single', agentName: 'agent-q' } as WorkflowNode,
    { id: D, kind: 'agent-single', agentName: 'agent-d' } as WorkflowNode,
    { id: X, kind: 'agent-single', agentName: 'borrow-x' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  // Cross-clarify CHANNEL edges (dropped from the dataflow DAG by isChannelEdge): Q asks via CC,
  // D is the graph designer (CC → D). These make D a valid graph designer so assertDesignerReady
  // resolves CC as its only source (exempt when CC's round is the dispatched origin).
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: Q, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: D, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: Q, portName: '__clarify_response__' },
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

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

async function seedTask(db: DbClient, taskId: string, _deferred = true): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p5-bc',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { status?: string; iteration?: number; hasOutput?: boolean; rerunCause?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: over.iteration ?? 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

/** Insert an answered clarify round (self or cross). */
async function seedAnsweredRound(
  db: DbClient,
  taskId: string,
  opts: {
    kind: 'self' | 'cross'
    askingNodeId: string
    questions: ClarifyQuestion[]
    status?: 'answered' | 'awaiting_human'
    loopIter?: number
    iteration?: number
  },
): Promise<{ roundId: string; askingRunId: string; intermediaryNodeRunId: string }> {
  const askingRunId = await seedRun(db, taskId, opts.askingNodeId, {
    status: 'awaiting_human',
    iteration: opts.loopIter ?? 0,
  })
  const intRunId = await seedRun(db, taskId, opts.kind === 'self' ? CL : CC, {
    status: 'awaiting_human',
  })
  const roundId = ulid()
  const status = opts.status ?? 'answered'
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: opts.kind,
    askingNodeId: opts.askingNodeId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: opts.kind === 'self' ? CL : CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: opts.kind === 'cross' ? D : null,
    loopIter: opts.loopIter ?? 0,
    iteration: opts.iteration ?? 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status,
    answeredAt: Date.now(),
  })
  return { roundId, askingRunId, intermediaryNodeRunId: intRunId }
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  sealed?: boolean
  dispatchedAt?: number | null
  triggerRunId?: string | null
  loopIter?: number
  /** R3-2 auto-split aging: explicit staged_at (older = dispatched first). */
  stagedAt?: number | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: e.questionId,
    sourceKind: e.roleKind === 'self' ? 'self' : 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: e.loopIter ?? 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: e.sealed ? Date.now() : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    triggerRunId: e.triggerRunId ?? null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

function entryRow(db: DbClient, id: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id))
}
function runRow(db: DbClient, id: string) {
  return db.select().from(nodeRuns).where(eq(nodeRuns.id, id))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ===========================================================================
// 自检 ② — park 源（loadUndispatchedSelfQuestionerTargets）逐题分类，不互相误抑/误 park
// ===========================================================================
describe('RFC-128 P5-BC park source — loadUndispatchedSelfQuestionerTargets', () => {
  test('sealed-undispatched self → parks home P; questioner → parks home Q', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
    })
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
    })
    const parked = await loadUndispatchedSelfQuestionerTargets(db, taskId)
    expect(parked.has(P)).toBe(true)
    expect(parked.has(Q)).toBe(true)
  })

  test('unsealed self (quick channel, sealed_at NULL) → NOT parked (golden-lock)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false,
    })
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has(P)).toBe(false)
  })

  test('dispatched + unconsumed (in-flight) → NOT parked; dispatched + done+output → NOT parked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // in-flight: dispatched, trigger bound to a still-running rerun.
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    const rerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r1.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: rerun,
    })
    // A node with ONLY an in-flight dispatched entry is NOT parked (it RUNS for q1).
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has(P)).toBe(false)
  })

  test('RFC-132 步骤1: (旧)non-deferred task 现在也 park（flag 停读，golden-lock 作废）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, false)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
    })
    // RFC-132 步骤1 (T8 flag 停读): non-deferred 概念消失——sealed+undispatched entry 现在也
    // park（与 deferred 一致），旧「non-deferred → empty」golden-lock 作废。
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has(P)).toBe(true)
  })
})

// ===========================================================================
// 自检 ① + double-injection 读侧半 — selectAnsweredRoundsForConsumer 排除已 dispatch 轮
// ===========================================================================

// ===========================================================================
// 自检 ③ + 黄金锁注入条件 (R2-4) — buildClarifyNodeQueueContext full-round byte-for-byte / partial sibling block
// ===========================================================================

// ===========================================================================
// 五契约 — dispatch readiness / rerun-cause / in-flight gate / auto-split / mixed-role
// ===========================================================================
describe('RFC-128 P5-BC dispatch contracts', () => {
  test('(a) readiness gate — UNSEALED self entry → reject (task-question-not-sealed), nothing stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
      status: 'awaiting_human',
    })
    await seedRun(db, taskId, P, { status: 'done', iteration: 0 }) // prior run to inherit
    const eid = await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false,
    })
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [eid], actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-not-sealed')
    expect((await entryRow(db, eid))[0]?.dispatchedAt).toBeNull() // nothing stamped
  })

  test('(b) rerun-cause by role — self → clarify-answer; questioner → cross-clarify-questioner-rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // self on P
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await seedRun(db, taskId, P, { status: 'done', iteration: 0 })
    const selfEid = await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
    })
    const selfRes = await dispatchTaskQuestions(db, taskId, [selfEid], actor)
    expect((await runRow(db, selfRes.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe('clarify-answer')

    // questioner on Q
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 't')],
    })
    await seedRun(db, taskId, Q, { status: 'done', iteration: 0 })
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
    })
    const qRes = await dispatchTaskQuestions(db, taskId, [qEid], actor)
    expect((await runRow(db, qRes.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe(
      'cross-clarify-questioner-rerun',
    )
  })

  test('(e) auto-split — same-home self+designer all staged → dispatch self, defer designer (no全量 reject)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // Cross-round coincidence: node D is the graph designer (CC → D) AND self-clarifies → both a
    // self entry (home D) and a designer entry (home D) staged on the SAME home D.
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 't')],
    })
    const selfEid = await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D,
      sealed: true,
    })
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 't')],
    })
    const desEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
    })

    const res = await dispatchTaskQuestions(db, taskId, [selfEid, desEid], actor)
    // self dispatched (priority 0), designer deferred (priority 2).
    expect(res.dispatchedEntryIds).toContain(selfEid)
    expect(res.dispatchedEntryIds).not.toContain(desEid)
    expect(res.deferred.some((d) => d.entryId === desEid)).toBe(true)
    expect((await entryRow(db, selfEid))[0]?.dispatchedAt).not.toBeNull()
    expect((await entryRow(db, desEid))[0]?.dispatchedAt).toBeNull() // deferred → still staged
    // The dispatched self rerun's cause is the self cause.
    expect((await runRow(db, res.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe('clarify-answer')
  })

  test('(e) auto-split FAIRNESS (R3-2) — an OLDER delayed designer wins over a NEWER same-home self/q (no starvation)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // Starvation scenario: the designer was staged LONG AGO (delayed by a prior batch), and a NEW
    // same-home self question was staged just now. A fixed "self/q always first" would re-pick the
    // newcomer self forever → the older designer starves. Aging (oldest staged_at first) fixes it:
    // the older designer is dispatched, the newer self is deferred.
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 't')],
    })
    const desEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
      stagedAt: 1000, // staged long ago (delayed)
    })
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 't')],
    })
    const selfEid = await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D,
      sealed: true,
      stagedAt: 9_000_000, // staged just now (newcomer)
    })

    const res = await dispatchTaskQuestions(db, taskId, [selfEid, desEid], actor)
    // Aging beats the §0 self/q-first default: the OLDER designer is dispatched, the NEWER self is
    // deferred — so the designer cannot be starved by a stream of fresh self questions.
    expect(res.dispatchedEntryIds).toContain(desEid)
    expect(res.dispatchedEntryIds).not.toContain(selfEid)
    expect(res.deferred.some((d) => d.entryId === selfEid)).toBe(true)
    expect((await runRow(db, res.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe('cross-clarify-answer')
  })

  test('(d) in-flight gate — same-home in-flight self blocks a later designer dispatch until done+output', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // D is the graph designer AND self-clarifies (shared home). A self dispatch on D is already
    // in-flight (trigger bound to a running rerun on D).
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 't')],
    })
    const inflight = await seedRun(db, taskId, D, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: inflight,
    })
    // A designer entry whose HOME is also D, staged. assertDesignerReady passes (CC exempt), so we
    // reach the EXTENDED in-flight gate (R2-2) which sees the in-flight self on D → reject.
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 't')],
    })
    const desEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
    })
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [desEid], actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-node-dispatch-in-flight')
  })

  test('(c) mixed-role grouping — questioner + designer DIFFERENT home, one batch → both dispatched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, Q, { status: 'done', iteration: 0 })
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // One cross round → questioner entry (home Q) + designer entry (home D), both sealed.
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 't')],
    })
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
    })
    const dEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
    })
    const res = await dispatchTaskQuestions(db, taskId, [qEid, dEid], actor)
    expect(res.dispatchedEntryIds).toContain(qEid)
    expect(res.dispatchedEntryIds).toContain(dEid)
    expect(res.deferred.length).toBe(0)
  })

  test('(c2) per-origin designer split does NOT block a pure questioner dispatch (Codex impl-gate F4 scoping)', async () => {
    // Codex impl-gate F4 scoping fix: after the designer-only filter was removed from `requested`,
    // a pure QUESTIONER dispatch from a cross round must NOT be blocked by that round's SPLIT
    // (multi-target) undispatched DESIGNER entries — the questioner rerun neither consumes nor
    // mints them. The per-origin designer single-target check is scoped to the origins of the
    // requested DESIGNER entries (none here), so a pure self/questioner dispatch carries no
    // designer multi-target constraint.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, Q, { status: 'done', iteration: 0 })
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // questioner entry (home Q) — the one we dispatch.
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
    })
    // SPLIT designer entries on the SAME round, undispatched: q1 → default D, q2 → override X (two
    // effective targets D/X). Under the old (all-origin) scope these would reject the questioner.
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
    })
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q2',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      overrideTargetNodeId: X,
      sealed: true,
    })
    // Pure questioner dispatch → succeeds (NOT blocked by the split designer entries).
    const res = await dispatchTaskQuestions(db, taskId, [qEid], actor)
    expect(res.dispatchedEntryIds).toContain(qEid)
    expect((await runRow(db, res.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe(
      'cross-clarify-questioner-rerun',
    )
  })
})

// ===========================================================================
// 自检 ④ + collapse 推翻 (§5.2.12) — three-ledger borrow conflict
// ===========================================================================
describe('RFC-128 P5-BC three-ledger borrow (collapse 推翻)', () => {
  test('deferred-selfQ × designer SAME TARGET → reject (task-question-borrow-ledger-conflict)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // RFC-131 T4 去借壳: the ledger is keyed on the EFFECTIVE TARGET, not the origin home. Put both a
    // dispatched self entry AND a dispatched designer entry on the SAME target X (each reassigned to X,
    // run-self there). Two open ledgers on ONE node are separate pending reruns with mutually-exclusive
    // causes → duplicate execution → reject. (Pre-131 both homed on P via borrow; de-borrow moves each
    // to its target, so the conflict is now resolved by keying the SAME node.)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      overrideTargetNodeId: X,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: P,
      overrideTargetNodeId: X,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    let caught: unknown
    try {
      await resolveBorrowForNode(db, taskId, X, 0, liveDef())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-borrow-ledger-conflict')
  })

  test('deferred-selfQ alone → resolves run-self on target (no borrow, no conflict)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      overrideTargetNodeId: X,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    // RFC-131 T4 去借壳: the reassigned self entry's rerun is minted ON the target X, which runs its
    // OWN agent — resolveBorrowForNode(X) is null (no borrow), NOT 'borrow-x' on the origin P.
    expect(await resolveBorrowForNode(db, taskId, X, 0, liveDef())).toBeNull()
  })

  test('deferred-selfQ RUN-SELF (no override) + same-target designer RUN-SELF → reject (run-self counts, Codex impl-gate)', async () => {
    // Codex impl-gate run-self fix (§5.2.3④): a DISPATCHED self entry with NO override (run-self —
    // reruns the node's OWN agent) is still an OPEN ledger. On the same target D as an open designer
    // ledger, the two are separate pending reruns (clarify-answer vs cross-clarify-answer) →
    // duplicate execution → reject. The earlier code's null-for-run-self made this escape.
    // RFC-131 T4 去借壳: the designer entry is now ALSO run-self on D (no borrow); two open ledgers on
    // the SAME target D still conflict — the reject counts OPEN ledgers, not non-null borrow agents.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Dispatched self entry on target D, NO override (run-self), sealed → deferred-selfQ run-self ledger.
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D,
      overrideTargetNodeId: null, // run-self
      sealed: true,
      dispatchedAt: Date.now(),
    })
    // Dispatched designer entry on the SAME target D, run-self (no override) → designer run-self ledger.
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 't')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      overrideTargetNodeId: null, // run-self (de-borrow)
      sealed: true,
      dispatchedAt: Date.now(),
    })
    let caught: unknown
    try {
      await resolveBorrowForNode(db, taskId, D, 0, liveDef())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-borrow-ledger-conflict')
  })

  test('Codex round-5 finding 1: a CONTROL-channel dispatched self + its pending rerun is NOT a false ledger-conflict', async () => {
    // A fully-sealed control-channel self round, DISPATCHED (its continuation pending), is the
    // DEFERRED self/questioner ledger — NOT the immediate ledger. The oracle must EXCLUDE it from
    // the immediate ledger (it has a sealed self task_question), so resolving the legitimate
    // control-channel rerun is a single open ledger (deferred), not a multi-ledger conflict. Before
    // the round-5 fix the truth-source oracle counted it as BOTH immediate (round answered + pending
    // role-cause run) AND deferred → false 'task-question-borrow-ledger-conflict'.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('sq', 't')],
    })
    // Control-channel: SEALED + DISPATCHED, run-self (no override) → deferred self ledger.
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    // The dispatched continuation rerun (same role-cause as a quick-channel continuation).
    await seedRun(db, taskId, P, { status: 'pending', iteration: 0, rerunCause: 'clarify-answer' })
    // Resolves WITHOUT throwing — control-channel round excluded from the immediate ledger → only
    // the deferred ledger is open (run-self → null), no false conflict.
    expect(await resolveBorrowForNode(db, taskId, P, 0, liveDef())).toBeNull()
  })
})

// ===========================================================================
// §5.2.14 mixed-path write-flow — control-channel partial seal/dispatch interleaved with the quick
// whole-round finalize. RFC-132: the finalize IS autoDispatchClarifyRound (per-entry seal +
// dispatch) — it handles a dispatched/mixed round by sealing the rest and PARKING on a same-home
// conflict, so the legacy step-1 reject ('clarify-quick-finalize-round-dispatched'), the step-2
// consume (confirmation='confirmed'), and the submit-side source-order locks died with the legacy
// quick channel (the mixed-flow equivalents live in rfc128-p5-d-autodispatch.test.ts). What stays
// locked here: virgin-finalize lazy-reconcile idempotency, the RFC-076 final-state observables,
// the concurrent double-submit race, and the question-write lock (B) serialization contracts.
// ===========================================================================
describe('RFC-128 P5-BC §5.2.14 mixed-path write-flow', () => {
  // finding 3 (lazy-reconcile 复活 防回归, regression ③): a VIRGIN quick-finalize (question list
  // never opened, no control seal — 0 task_questions at submit) must NOT let a LATER lazy reconcile
  // create OPEN, dispatchable self entries on the now-answered round. The unified finalize
  // (autoDispatchClarifyRound) materializes + seals + DISPATCHES them; a subsequent lazy reconcile
  // is idempotent (preserves the dispatch stamp) → the entries stay non-re-dispatchable, so the
  // round cannot be re-minted.
  test('finding 3 — virgin quick-finalize: entries sealed+dispatched, lazy reconcile cannot revive them', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: P,
      askingNodeRunId: pRun,
      askingShardKey: null,
      intermediaryNodeId: CL,
      iteration: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // Virgin: no listTaskQuestions / no seal before the quick finalize.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      actor,
    })
    const afterSubmit = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    // The seal reconciled BOTH self entries and the auto-dispatch stamped them.
    expect(afterSubmit.length).toBe(2)
    expect(
      afterSubmit.every(
        (e) => e.roleKind === 'self' && e.sealedAt !== null && e.dispatchedAt !== null,
      ),
    ).toBe(true)
    // The later LAZY reconcile (listTaskQuestions path) must NOT reset them to undispatched/open.
    const roundRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    reconcileTaskQuestionsForRound(db, roundRows[0]!)
    const afterReconcile = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    expect(afterReconcile.every((e) => e.sealedAt !== null && e.dispatchedAt !== null)).toBe(true)
    // Not re-dispatchable (dispatch CAS skips already-dispatched) → no duplicate mint.
    const redispatch = await dispatchTaskQuestions(
      db,
      taskId,
      afterReconcile.map((e) => e.id),
      actor,
    )
    expect(redispatch.dispatchedEntryIds.length).toBe(0)
  })

  // RFC-076 final-state observables: after a quick-finalize the rerun is minted (pending) + the
  // session answered (dual-write) + the clarify node closed (done). (The unified path runs
  // seal-tx → dispatch-tx, so the ordering is close-then-mint with the sealed-undispatched PARK
  // pinning the frontier in between — RFC-076 T0 equivalent protection; the final state is
  // identical to the legacy mint→write→close.)
  test('RFC-076: after quick-finalize, rerun(pending) + session(answered) + clarify(done)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: P,
      askingNodeRunId: pRun,
      askingShardKey: null,
      intermediaryNodeId: CL,
      iteration: 0,
      questions: [mkQ('q1', 't')],
    })
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    const rerunNodeRunId = res.dispatch.reruns[0]!.nodeRunId
    // mint present (pending, clarify-answer, on the asking node).
    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.status).toBe('pending')
    expect(rerun?.rerunCause).toBe('clarify-answer')
    expect(rerun?.nodeId).toBe(P)
    // session answered.
    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.status).toBe('answered')
    // clarify node closed (done) — the LAST step, after the rerun is committed.
    const clarifyRun = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId))
    )[0]
    expect(clarifyRun?.status).toBe('done')
  })

  // finding 1 (regression ①): two CONCURRENT quick-finalizes on the same awaiting_human round
  // (both pass the pre-seal read) must mint EXACTLY ONE clarify-answer rerun — the in-tx seal
  // guards (re-seal reject / answered-round reject, all under lock B) make the loser reject.
  // (Outcome-deterministic regardless of await interleaving: one resolves, one rejects, one rerun.)
  test('finding 1 — concurrent double-submit mints exactly ONE clarify-answer rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: P,
      askingNodeRunId: pRun,
      askingShardKey: null,
      intermediaryNodeId: CL,
      iteration: 0,
      questions: [mkQ('q1', 't')],
    })
    const results = await Promise.allSettled([
      autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      }),
      autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected.length).toBe(1)
    // WHICH unified guard rejects the loser depends on the await interleaving: guard 1a
    // (clarify-already-answered), the in-tx re-seal reject, or the empty-subset reject.
    const loserCode = (rejected[0]!.reason as { code?: string }).code
    expect(loserCode).toBeDefined()
    expect([
      'clarify-already-answered',
      'clarify-question-already-sealed',
      'clarify-seal-empty',
    ]).toContain(loserCode!)
    // Exactly ONE clarify-answer rerun on P — no double mint.
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === P && r.rerunCause === 'clarify-answer',
    )
    expect(reruns.length).toBe(1)
  })

  // §5.2.14 final-gate (question-write lock) regression ②: the lock is per-task (taskId) + a SEPARATE
  // registry from the long-held worktree write lock — different tasks never block each other, and the
  // short question-write lock is never the long worktree sem.
  test('question-write lock — per-task + distinct from the worktree write sem', () => {
    expect(getTaskQuestionWriteSem('task-A')).toBe(getTaskQuestionWriteSem('task-A')) // same task ⇒ same
    expect(getTaskQuestionWriteSem('task-A')).not.toBe(getTaskQuestionWriteSem('task-B')) // per-task
    expect(getTaskQuestionWriteSem('task-A')).not.toBe(getTaskWriteSem('task-A')) // distinct registry
  })

  // §5.2.14 final-gate regression ①: a CONCURRENT dispatch + quick-finalize targeting the SAME home
  // serialize via the question-write lock → exactly ONE clarify-answer rerun (no double-mint, no
  // stale-precheck rollback clobber). Whoever wins the lock commits; the loser observes the committed
  // state and rejects/no-ops. Outcome-deterministic regardless of which wins.
  test('question-write lock — concurrent dispatch + quick-finalize on the same home → exactly one rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: P,
      askingNodeRunId: pRun,
      askingShardKey: null,
      intermediaryNodeId: CL,
      iteration: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // q1 control-sealed-undispatched → dispatchable; the round is still awaiting (quick-finalizable).
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    const q1 = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    ).find((e) => e.questionId === 'q1' && e.roleKind === 'self')
    expect(q1).toBeDefined()
    // Fire both concurrently — the question-write lock serializes them. Whichever wins B first,
    // the loser CAS-skips the already-dispatched q1 / parks on the same-home in-flight conflict.
    await Promise.allSettled([
      dispatchTaskQuestions(db, taskId, [q1!.id], actor),
      autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1'), ans('q2')],
        actor,
      }),
    ])
    // Exactly ONE clarify-answer rerun on P — no double mint under concurrency.
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === P && r.rerunCause === 'clarify-answer',
    )
    expect(reruns.length).toBe(1)
  })
})

// ===========================================================================
// §5.2.14 final-gate (2nd round) — critical-section boundary findings:
//   ②(b) sealRoundQuestions must take lock B (was its own unlocked tx);
//   ②(a) locked-answer preservation: a committed control seal is never overwritten by a later
//        whole-round finalize (the unified finalize filters lockedIds; the merge runs in the seal
//        tx UNDER B). The legacy submit-side source-order locks (②(a) self/cross + ① deferred
//        reconcile-in-flip-tx) were deleted with the legacy quick channel (RFC-132 §8).
// ===========================================================================
describe('RFC-128 §5.2.14 final-gate (2nd round) — seal/merge/deferred critical-section under lock B', () => {
  function fnBody(src: string, signature: string): string {
    const start = src.indexOf(signature)
    expect(start).toBeGreaterThan(-1)
    const after = src.indexOf('\nexport ', start + 1)
    return src.slice(start, after === -1 ? undefined : after)
  }

  // ②(b) — sealRoundQuestions writes the round's answers_json + task_questions, so it MUST serialize on
  // the SAME per-task question-write lock B as the quick submits. Source-lock: its dbTxSync runs inside
  // getTaskQuestionWriteSem(...).run(runSealTx). (Behaviorally hard to force the unlocked race; the lock
  // closes it structurally.)
  test('②(b) — sealRoundQuestions runs its tx under getTaskQuestionWriteSem (lock B)', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/clarifySeal.ts'), 'utf8')
    const fn = fnBody(src, 'export async function sealRoundQuestions')
    expect(fn.includes('getTaskQuestionWriteSem(')).toBe(true)
    expect(fn.includes('.run(runSealTx)')).toBe(true)
    expect(fn.includes('dbTxSync(args.db')).toBe(true)
  })

  // ②(a) behavioral — control-seal q1 = option A, then quick-finalize the WHOLE round posting a
  // DIFFERENT q1 = option B (+ q2): the sealed q1 stays A (locked-answer preserved), proving the
  // under-B merge keeps a committed seal. (Sequential is the deterministic shadow of the race the
  // under-B move closes; the concurrent serialization is covered by the lock test above.)
  test('②(a) behavioral — a control-sealed answer is NOT overwritten by a later quick whole-round finalize', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const dRun = await seedRun(db, taskId, D, { status: 'awaiting_human', iteration: 0 })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: D,
      askingNodeRunId: dRun,
      askingShardKey: null,
      intermediaryNodeId: CL,
      iteration: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // control-seal q1 = option A.
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    // quick-finalize (unified autodispatch), posting a DIFFERENT q1 (option B) + q2 (option A).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [1],
          selectedOptionLabels: ['B'],
          customText: '',
        },
        ans('q2'),
      ],
      actor,
    })
    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.status).toBe('answered')
    const finalAnswers = JSON.parse(sess!.answersJson ?? '[]') as Array<{
      questionId: string
      selectedOptionLabels: string[]
    }>
    // sealed q1 = A preserved (NOT the quick's posted B); q2 = A from the quick.
    expect(finalAnswers.find((a) => a.questionId === 'q1')?.selectedOptionLabels).toEqual(['A'])
    expect(finalAnswers.find((a) => a.questionId === 'q2')?.selectedOptionLabels).toEqual(['A'])
  })
})
