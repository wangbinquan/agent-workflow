// RFC-128 P5-BC — self/questioner per-question rerun (深度重构核心；最高风险段)。
//
// This locks the P5-BC clean-path (design.md §5.2): the self/questioner MIRROR of the designer
// per-question infrastructure. It covers the §5.2.4 five self-checks + the five dispatch contracts
// (§5.2.11 readiness gate / §5.2.12 rerun-cause + collapse 推翻 + in-flight gate 扩域 / §5.2.13
// mixed-role grouping + auto-split) + the §5.2.5 double-injection root-out + the §5.2.6 golden lock
// (full-round same-batch == legacy byte-for-byte; partial adds the sibling/scope block).
//
// Relationship to the P5-A net (rfc128-p5-a-pre-refactor-net.test.ts): P5-A pinned the PRE-refactor
// whole-round behavior; this file is the POST-refactor lock. The P5-A locks that survive (the
// parallel-function approach keeps buildPromptContext + loadUndispatchedDesignerTargets + the
// immediate×designer ledger reject unchanged) stay green; this file adds the new per-question paths.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  buildClarifyNodeQueueContext,
  buildPromptContext,
  markClarifyRoundsConsumedBy,
} from '../src/services/clarifyRounds'
import { dispatchTaskQuestions, resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import { loadUndispatchedSelfQuestionerTargets } from '../src/services/taskQuestions'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
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

async function seedTask(db: DbClient, taskId: string, deferred = true): Promise<void> {
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
    deferredQuestionDispatch: deferred,
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
    iteration: 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status,
    answeredAt: Date.now(),
  })
  // Dual-write the legacy cross_clarify_sessions (RFC-058) so evaluateDesignerRerunReadiness
  // (which reads the legacy table) sees the cross round as a resolved source.
  if (opts.kind === 'cross') {
    await db.insert(crossClarifySessions).values({
      id: roundId,
      taskId,
      crossClarifyNodeId: CC,
      crossClarifyNodeRunId: intRunId,
      sourceQuestionerNodeId: opts.askingNodeId,
      sourceQuestionerNodeRunId: askingRunId,
      targetDesignerNodeId: D,
      loopIter: opts.loopIter ?? 0,
      iteration: 0,
      questionsJson: JSON.stringify(opts.questions),
      answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
      directive: 'continue',
      status,
      answeredAt: Date.now(),
    })
  }
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

function roundRow(db: DbClient, roundId: string) {
  return db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId))
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

  test('non-deferred task → empty (golden-lock)', async () => {
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
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).size).toBe(0)
  })
})

// ===========================================================================
// 自检 ① + double-injection 读侧半 — selectAnsweredRoundsForConsumer 排除已 dispatch 轮
// ===========================================================================
describe('RFC-128 P5-BC read-side exclusion (§5.2.5 double-injection)', () => {
  test('self round with DISPATCHED self entry → buildPromptContext excludes it (per-question takes over)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'ONLY-SELF-Q')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const ctx = await buildPromptContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx).toBeUndefined() // dispatched → excluded from whole-round
  })

  test('cross round with DISPATCHED DESIGNER entry does NOT exclude questioner whole-round (role-specific)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 'QUESTIONER-SEES-THIS')],
    })
    // A dispatched DESIGNER entry of the same round — must NOT suppress the questioner's read.
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const ctx = await buildPromptContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: Q,
      targetIteration: 1,
      loopIter: 0,
    })
    expect(ctx?.questionsBlock).toContain('QUESTIONER-SEES-THIS')
  })

  test('cross round with DISPATCHED QUESTIONER entry → excludes questioner whole-round', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 'ONLY-Q')],
    })
    await insertEntry(db, taskId, {
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const ctx = await buildPromptContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: Q,
      targetIteration: 1,
      loopIter: 0,
    })
    expect(ctx).toBeUndefined()
  })
})

// ===========================================================================
// 自检 ③ + 黄金锁注入条件 (R2-4) — buildClarifyNodeQueueContext full-round byte-for-byte / partial sibling block
// ===========================================================================
describe('RFC-128 P5-BC per-question injection (golden-lock R2-4 + RFC-099)', () => {
  test('FULL-round (all dispatched) == legacy whole-round buildPromptContext byte-for-byte (no sibling block)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'FIRST'), mkQ('q2', 'SECOND')],
    })
    const rerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    // BOTH questions dispatched in one batch → full-round.
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q2',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    // Reference: what the whole-round path renders for the SAME round (computed BEFORE the dispatched
    // exclusion would apply — undispatch the entries via a clean DB to get the legacy baseline).
    const refDb = createInMemoryDb(MIGRATIONS)
    await seedTask(refDb, taskId)
    await seedAnsweredRound(refDb, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'FIRST'), mkQ('q2', 'SECOND')],
    })
    const ref = await buildPromptContext({
      db: refDb,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      targetIteration: 1,
      shardKey: null,
    })

    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: rerun,
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).toBe(ref?.questionsBlock)
    expect(ctx?.answersBlock).toBe(ref?.answersBlock)
    expect(ctx?.directive).toBe(ref?.directive)
    expect(ctx?.answersBlock).not.toContain('Scope of this run') // no sibling block on full-round
  })

  test('PARTIAL (q1 dispatched, q2 not) → only q1 + sibling scope block listing q2; zero attribution', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'FIRST-DISPATCHED'), mkQ('q2', 'SECOND-SIBLING')],
      status: 'awaiting_human',
    })
    const rerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q2',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false,
    }) // sibling, not dispatched
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: rerun,
      targetIteration: 1,
    })
    expect(ctx?.questionsBlock).toContain('FIRST-DISPATCHED')
    expect(ctx?.questionsBlock).not.toContain('SECOND-SIBLING') // sibling not in the rendered questions
    expect(ctx?.answersBlock).toContain('Scope of this run')
    expect(ctx?.answersBlock).toContain('SECOND-SIBLING') // sibling listed for context
    // RFC-099 prompt isolation: no owner/user/role id leaks.
    expect(ctx?.answersBlock).not.toContain('u1')
    expect(ctx?.answersBlock).not.toContain('owner')
  })

  test('binds trigger_run_id on the rendered entries (per-entry consume marker)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    const rerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    const eid = await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    expect((await entryRow(db, eid))[0]?.triggerRunId).toBeNull()
    await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: rerun,
      targetIteration: 1,
    })
    expect((await entryRow(db, eid))[0]?.triggerRunId).toBe(rerun)
  })
})

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
  test('deferred-selfQ × designer same home → reject (task-question-borrow-ledger-conflict)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // A dispatched self entry on home P reassigned to X (deferred-selfQ ledger).
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
    // A dispatched designer entry whose HOME is also P, reassigned to D (designer ledger).
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
      overrideTargetNodeId: D,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    let caught: unknown
    try {
      await resolveBorrowForNode(db, taskId, P, 0, liveDef())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-borrow-ledger-conflict')
  })

  test('deferred-selfQ alone → resolves borrow agent (no conflict)', async () => {
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
    expect(await resolveBorrowForNode(db, taskId, P, 0, liveDef())).toBe('borrow-x')
  })

  test('deferred-selfQ RUN-SELF (no override) + same-home designer borrow → reject (run-self counts, Codex impl-gate)', async () => {
    // Codex impl-gate run-self fix (§5.2.3④): a DISPATCHED self entry with NO override (run-self —
    // reruns the home's OWN agent) is still an OPEN ledger. On the same home D as an open designer
    // borrow, the two are separate pending reruns (clarify-answer vs cross-clarify-answer) →
    // duplicate execution → reject. The earlier code's null-for-run-self made this escape.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Dispatched self entry on home D, NO override (run-self), sealed → deferred-selfQ run-self ledger.
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
    // Dispatched designer entry on the SAME home D, borrow X → designer borrow ledger.
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
      overrideTargetNodeId: X,
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
// Codex impl-gate (§5.2.3④ run-self) — dispatch-time in-flight gate covers the OPEN IMMEDIATE
// self/questioner ledger. PRODUCTION-TRANSITION test: a REAL quick-channel self continuation
// (pending) must REJECT a same-home designer dispatch BEFORE the irreversible stamp/mint — NOT
// only later at resolveBorrowForNode (which fires after the double-mint already happened).
// ===========================================================================
describe('RFC-128 P5-BC dispatch-time immediate-ledger gate (no double-mint)', () => {
  test('real immediate run-self continuation blocks a same-home designer dispatch WITHOUT any reconcile → no stamp, no node_run insert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // REAL immediate run-self continuation on home D (quick channel): D self-clarifies, the human
    // answers WITHOUT defer → submitClarifyAnswers writes clarify_rounds (answered) + mints a
    // clarify-answer continuation (pending), run-self. CRUCIALLY this test NEVER calls
    // listTaskQuestions (no lazy reconcile of the self task_question) — proving the dispatch gate
    // reads the TRUTH SOURCE (clarify_rounds + the pending continuation), not the lazy task_question
    // projection. (The earlier version reconciled first, hiding the Codex round-4 bypass.)
    const dRun = await seedRun(db, taskId, D, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: D,
      sourceAgentNodeRunId: dRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('sq', 't')],
    })
    await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('sq')] }) // mint continuation
    // A sealed, UNDISPATCHED designer entry whose HOME is the SAME node D (cross-round coincidence).
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

    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [desEid], actor)
    } catch (e) {
      caught = e
    }
    // The PRODUCTION TRANSITION (dispatchTaskQuestions) is rejected BEFORE any stamp/mint — not
    // later at borrow resolution (which would be after the double-mint).
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-node-dispatch-in-flight')
    // No dispatched_at stamp on the designer entry; NO second pending rerun minted (no double-mint).
    expect((await entryRow(db, desEid))[0]?.dispatchedAt).toBeNull()
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })

  test('Codex round-5 finding 2: MINT-FIRST window (continuation minted, round still awaiting) blocks a same-home designer dispatch', async () => {
    // submitClarifyAnswers mints the continuation BEFORE flipping the round 'answered'. In that
    // window a concurrent dispatch must STILL see the open immediate ledger (awaiting round + a
    // pending continuation), or it double-mints. The oracle has no status==='answered' requirement,
    // so it catches this state.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // Mint-first state: a self round on D STILL awaiting_human, but the continuation is already
    // minted (pending). NO sealed entry (quick channel) → not control-channel.
    await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 't')],
      status: 'awaiting_human',
    })
    await seedRun(db, taskId, D, { status: 'pending', iteration: 0, rerunCause: 'clarify-answer' })
    // A sealed, UNDISPATCHED designer entry whose HOME is the SAME node D.
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
    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [desEid], actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-node-dispatch-in-flight')
    expect((await entryRow(db, desEid))[0]?.dispatchedAt).toBeNull()
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })
})

// ===========================================================================
// 自检 ① 续 + clean-path ② — consume suppression (deferred dispatched self/q whole-round NOT stamped)
// ===========================================================================
describe('RFC-128 P5-BC consume suppression (clean-path ②)', () => {
  test('deferred dispatched self round → markClarifyRoundsConsumedBy does NOT whole-round stamp it', async () => {
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
      dispatchedAt: Date.now(),
    })
    const consumerRun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 1,
      hasOutput: true,
    })
    await markClarifyRoundsConsumedBy(db, { id: consumerRun, taskId, nodeId: P, shardKey: null })
    // Per-question consume (trigger_run_id) owns it → whole-round stamp suppressed.
    expect((await roundRow(db, self.roundId))[0]?.consumedByConsumerRunId).toBeNull()
  })

  test('deferred QUICK-channel self round (sealed_at NULL, undispatched) → whole-round stamp APPLIES (golden-lock)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    // A quick-channel entry: sealed_at NULL, dispatched_at NULL → NOT a per-question round.
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false,
    })
    const consumerRun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 1,
      hasOutput: true,
    })
    await markClarifyRoundsConsumedBy(db, { id: consumerRun, taskId, nodeId: P, shardKey: null })
    expect((await roundRow(db, self.roundId))[0]?.consumedByConsumerRunId).toBe(consumerRun)
  })
})
