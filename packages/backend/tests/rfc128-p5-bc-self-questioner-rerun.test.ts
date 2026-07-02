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
  clarifySessions,
  crossClarifySessions,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { readFileSync } from 'node:fs'
import { buildClarifyNodeQueueContext, buildPromptContext } from '../src/services/clarifyRounds'
import { dispatchTaskQuestions, resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import {
  loadUndispatchedSelfQuestionerTargets,
  reconcileTaskQuestionsForRound,
} from '../src/services/taskQuestions'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
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
  // RFC-132 (PR-C / design §8): the FULL-round byte-for-byte lock (buildClarifyNodeQueueContext ==
  // legacy whole-round buildPromptContext) was DELETED — the round-grouped rendering it locked is
  // superseded by the single flat `## Clarify Q&A` block. The flat render golden now lives in
  // rfc132-flat-render.test.ts (renderFlatClarifyQueue), and the scheduler-integration flat assertions
  // live in scheduler-clarify-dispatch / -multiround-aging / -inline. The PARTIAL (sibling scope) +
  // MULTI-ROUND cases below still exercise the (dead-until-PR-E) buildClarifyNodeQueueContext directly.

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

  test('MULTI-ROUND: a round-2 dispatch rerun still injects round-1 as read-only history (2026-07-01 deadlock followup)', async () => {
    // Live task 01KWDKBS: round 1 dispatched + consumed by an earlier rerun (its per-question window is
    // upper-bounded by the next clarify rerun); round 2 dispatched to THIS rerun. The OLD node-queue
    // path rendered ONLY round 2 (round 1's entries excluded by isQueueEntryRenderableForRun), so the
    // agent lost round 1's decisions (the generated doc dropped round 1's "API / UI wireframe /
    // pseudocode" requirement). NOW round 1 must appear as full read-only history + round 2 as current.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Round 1 (iteration 0) — dispatched, consumed by prevRerun; curRerun (next clarify rerun) upper-
    // bounds round-1's window so its entries are NOT renderable for the current run.
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 0,
      questions: [mkQ('r1q1', 'ROUND1-PLATFORM'), mkQ('r1q2', 'ROUND1-DOCDEPTH')],
    })
    const prevRerun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    for (const q of ['r1q1', 'r1q2']) {
      await insertEntry(db, taskId, {
        originNodeRunId: r1.intermediaryNodeRunId,
        questionId: q,
        roleKind: 'self',
        defaultTargetNodeId: P,
        sealed: true,
        dispatchedAt: Date.now(),
        triggerRunId: prevRerun,
      })
    }
    // Round 2 (iteration 1) — dispatched to THIS rerun.
    const r2 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 1,
      questions: [mkQ('r2q1', 'ROUND2-LANG'), mkQ('r2q2', 'ROUND2-GRID')],
    })
    const curRerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    for (const q of ['r2q1', 'r2q2']) {
      await insertEntry(db, taskId, {
        originNodeRunId: r2.intermediaryNodeRunId,
        questionId: q,
        roleKind: 'self',
        defaultTargetNodeId: P,
        sealed: true,
        dispatchedAt: Date.now(),
      })
    }

    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: curRerun,
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    // BOTH rounds present — round 1 was silently dropped before the fix.
    expect(ctx?.questionsBlock).toContain('ROUND1-PLATFORM')
    expect(ctx?.questionsBlock).toContain('ROUND1-DOCDEPTH')
    expect(ctx?.questionsBlock).toContain('ROUND2-LANG')
    expect(ctx?.questionsBlock).toContain('ROUND2-GRID')
    // Round 1's ANSWERS injected too (agent sees resolved prior decisions).
    expect(ctx?.answersBlock).toContain('ROUND1-PLATFORM')
    expect(ctx?.answersBlock).toContain('ROUND2-LANG')
    // Chronological: Round 1 before Round 2.
    const r1idx = (ctx?.questionsBlock ?? '').indexOf('### Round 1')
    const r2idx = (ctx?.questionsBlock ?? '').indexOf('### Round 2')
    expect(r1idx).toBeGreaterThanOrEqual(0)
    expect(r2idx).toBeGreaterThan(r1idx)
    // Round 1 is read-only history — RFC-099: no attribution leak.
    expect(ctx?.answersBlock).not.toContain('u1')
  })

  test('AGING (self inject layer): home done+output ages its queue → entry excluded from a later rerun', async () => {
    // RFC-131 §2 — the self-domain injection-layer counterpart of rfc120 §18 (designer domain).
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'AGED-Q')],
    })
    // The承接 rerun produced done+output → the entry (trigger=prodRerun) is aged.
    const prodRerun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 0,
      hasOutput: true,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prodRerun,
    })
    // A later rerun (id > prodRerun) sees the sole entry aged → nothing to inject.
    const laterRerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: laterRerun,
      targetIteration: 0,
    })
    expect(ctx).toBeUndefined()
  })

  test('ROUND N+1 (self inject layer): a new round bound AFTER a done+output is NOT aged by it (trigger id 序锚)', async () => {
    // The failure this locks: laden "target ever produced output" would falsely age round-2 entries
    // dispatched after round-1's output. The id-order anchor (r.id >= trigger) prevents it.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 0,
      questions: [mkQ('r1q', 'ROUND1-AGED')],
    })
    const prodRerun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 0,
      hasOutput: true,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r1.intermediaryNodeRunId,
      questionId: 'r1q',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prodRerun,
    })
    const r2 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 1,
      questions: [mkQ('r2q', 'ROUND2-FRESH')],
    })
    // Round 2's承接 rerun is minted AFTER the output → its id > prodRerun.
    const curRerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r2.intermediaryNodeRunId,
      questionId: 'r2q',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: curRerun,
    })
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: curRerun,
      targetIteration: 1,
    })
    // Round 1 aged (trigger=prodRerun, done+output, id >= trigger).
    expect(ctx?.questionsBlock ?? '').not.toContain('ROUND1-AGED')
    // Round 2 NOT aged: prodRerun's id < curRerun (its trigger) → the prior output doesn't touch it.
    expect(ctx?.questionsBlock).toContain('ROUND2-FRESH')
  })

  test('FAILED (self inject layer): a failed home run does NOT age the queue → entry re-injected on revive', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'FAILED-Q')],
    })
    // failed even WITH a stray output is NOT done → not aged (revivable).
    const failedRerun = await seedRun(db, taskId, P, {
      status: 'failed',
      iteration: 0,
      hasOutput: true,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: failedRerun,
    })
    const reviveRerun = await seedRun(db, taskId, P, {
      status: 'running',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: reviveRerun,
      targetIteration: 0,
    })
    expect(ctx?.questionsBlock).toContain('FAILED-Q')
  })

  test('CROSS-QUESTIONER MULTI-ROUND: round-2 rerun injects round-1 (questioner domain, done-no-output not aged)', async () => {
    // The questioner-domain mirror of the self MULTI-ROUND lock above (RFC-131: same isTargetNodeConsumed
    // predicate, consumerKind='cross-questioner' / roleKind='questioner').
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      iteration: 0,
      questions: [mkQ('cq1', 'CROSS-ROUND1')],
    })
    // The questioner node Q's own rerun consumes the answers → target = Q. prevRerun done-no-output.
    const prevRerun = await seedRun(db, taskId, Q, {
      status: 'done',
      iteration: 0,
      rerunCause: 'cross-clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r1.intermediaryNodeRunId,
      questionId: 'cq1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prevRerun,
    })
    const r2 = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      iteration: 1,
      questions: [mkQ('cq2', 'CROSS-ROUND2')],
    })
    const curRerun = await seedRun(db, taskId, Q, {
      status: 'running',
      iteration: 0,
      rerunCause: 'cross-clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r2.intermediaryNodeRunId,
      questionId: 'cq2',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: Q,
      dispatchedRunId: curRerun,
      targetIteration: 1,
    })
    // prevRerun done-no-output → round 1 NOT aged → both rounds accumulate.
    expect(ctx?.questionsBlock).toContain('CROSS-ROUND1')
    expect(ctx?.questionsBlock).toContain('CROSS-ROUND2')
  })

  test('CROSS-QUESTIONER AGING: questioner done+output ages its queue → later rerun excludes it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('cq1', 'CROSS-AGED')],
    })
    const prodRerun = await seedRun(db, taskId, Q, {
      status: 'done',
      iteration: 0,
      hasOutput: true,
      rerunCause: 'cross-clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: r1.intermediaryNodeRunId,
      questionId: 'cq1',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prodRerun,
    })
    const laterRerun = await seedRun(db, taskId, Q, {
      status: 'running',
      iteration: 0,
      rerunCause: 'cross-clarify-answer',
    })
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: Q,
      dispatchedRunId: laterRerun,
      targetIteration: 0,
    })
    expect(ctx).toBeUndefined()
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

  test('Codex round-6 finding: MIXED round (control-seal q1 + quick-finalize q2) — the quick continuation still blocks a same-home designer dispatch', async () => {
    // The REAL mixed path (clarify.ts loadSealedQuestionIds/mergeSealedAnswers): control-seal q1
    // (defer), then quick-finalize the whole round — submitClarifyAnswers preserves q1's locked
    // answer + mints a QUICK continuation for the round. q1 is control-sealed-but-UNDISPATCHED. The
    // earlier (round-5) origin-level SEALED exclusion wrongly treated the whole round as deferred →
    // the quick continuation was invisible → a same-home designer dispatch double-minted. The
    // round-6 fix excludes only DISPATCHED rounds, so the quick continuation stays in the immediate
    // ledger and the dispatch is rejected.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, D, { status: 'done', iteration: 0 })
    // D self-clarifies q1+q2.
    const dRun = await seedRun(db, taskId, D, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: D,
      sourceAgentNodeRunId: dRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // Control-channel seal q1 (partial) — q1's task_question is sealed_at SET, dispatched_at NULL.
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    // Quick-channel finalize the whole round → preserves q1's locked answer + mints a QUICK
    // continuation (no dispatch). NO listTaskQuestions reconcile.
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
    })
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
    // The quick continuation (q2) is visible despite q1 being control-sealed → reject, no double-mint.
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-node-dispatch-in-flight')
    expect((await entryRow(db, desEid))[0]?.dispatchedAt).toBeNull()
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })
})

// ===========================================================================
// §5.2.14 mixed-path write-flow refactor (RFC-076 否决区) — control-channel partial seal/dispatch
// interleaved with a quick whole-round finalize. Locks the 3-step coherent fix:
//   step 1 — quick-finalize REJECTs any round in control-channel dispatch mode (ANY dispatched
//            self/q entry, in-flight OR consumed) → no data-loss (read-side永久排除 the round);
//   step 2 — a quick-finalize CONSUMEs (confirmation='confirmed') the round's sealed-undispatched
//            self/q entries → no park starvation, no re-park, not re-dispatchable;
//   step 3 — the submit mint+flips run in ONE synchronous dbTxSync (atomic vs dispatch's dbTxSync),
//            RFC-076 mint→write→close ordering preserved (close after the tx).
// ===========================================================================
describe('RFC-128 P5-BC §5.2.14 mixed-path write-flow', () => {
  // step 1 (real control path, in-flight): seal q1 + DISPATCH it (mints an in-flight control rerun),
  // then quick-finalize the whole round → reject, NO second rerun (no double-mint).
  test('step 1 — control-dispatched q1 (in-flight) → quick-finalize rejected, no double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    const q1 = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    ).find((e) => e.questionId === 'q1' && e.roleKind === 'self')
    expect(q1).toBeDefined()
    await dispatchTaskQuestions(db, taskId, [q1!.id], actor)

    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    let caught: unknown
    try {
      await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1'), ans('q2')] })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-quick-finalize-round-dispatched')
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })

  // step 1 (finding 1 data-loss): a CONSUMED dispatched q1 (done+output) must STILL reject. The round
  // is PERMANENTLY excluded from the whole-round render path (roundsWithDispatchedEntries keys on
  // dispatched_at, never cleared), so a quick continuation would drop q2's answer. The guard keys on
  // ANY dispatched (NOT !consumed) — this is the flip of the earlier (wrong) "consumed unblocks" test.
  test('step 1 — CONSUMED dispatched q1 (done+output) → quick-finalize STILL rejected (no data-loss)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    const consumedRerun = await seedRun(db, taskId, P, {
      status: 'done',
      iteration: 0,
      rerunCause: 'clarify-answer',
      hasOutput: true,
    })
    await insertEntry(db, taskId, {
      originNodeRunId: clarifyNodeRunId,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: consumedRerun,
    })
    let caught: unknown
    try {
      await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1'), ans('q2')] })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-quick-finalize-round-dispatched')
  })

  // step 2 (consume — fixes park starvation + duplicate): seal q1 (UNDISPATCHED) parks P; a quick
  // whole-round finalize then SUPERSEDES q1 (marks it confirmed) → P no longer parks, q1 is not
  // re-dispatchable, and the continuation is minted.
  test('step 2 — quick-finalize consumes sealed-undispatched q1 → not parked, not re-dispatchable', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    // Sealed-undispatched q1 parks P (the pre-finalize state).
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has(P)).toBe(true)

    await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1'), ans('q2')] })

    const after = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    const q1After = after.find((e) => e.questionId === 'q1' && e.roleKind === 'self')
    const q2After = after.find((e) => e.questionId === 'q2' && e.roleKind === 'self')
    // BOTH the sealed q1 AND the quick-answered (unsealed) sibling q2 are superseded → confirmed
    // (Codex finding A: partial seal reconciled a row for EVERY question; the whole-round finalize
    // answers them all, so the consume confirms the whole round — not just the sealed subset).
    expect(q1After?.confirmation).toBe('confirmed')
    expect(q2After).toBeDefined()
    expect(q2After?.confirmation).toBe('confirmed')
    // P no longer parks (the superseded entries dropped out of the park source).
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has(P)).toBe(false)
    // Neither q1 nor q2 is re-dispatchable (dispatch skips confirmed) → empty dispatch.
    const redispatch = await dispatchTaskQuestions(db, taskId, [q1After!.id, q2After!.id], actor)
    expect(redispatch.dispatchedEntryIds.length).toBe(0)
    // The quick continuation WAS minted (a pending clarify-answer rerun on P).
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === P && r.rerunCause === 'clarify-answer' && r.status === 'pending',
    )
    expect(reruns.length).toBe(1)
  })

  // step 3 / finding 3 (lazy-reconcile 复活 防回归, regression ③): a VIRGIN quick-finalize (question
  // list never opened, no control seal — 0 task_questions at submit) must NOT let a LATER lazy
  // reconcile create OPEN, dispatchable self entries on the now-answered round. The in-tx reconcile
  // materializes + confirms them at submit; a subsequent lazy reconcile is idempotent (preserves
  // confirmed) → the entries stay non-dispatchable, so the round cannot be re-minted.
  test('finding 3 — virgin quick-finalize: in-tx reconcile confirms entries, lazy reconcile cannot revive them', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // Virgin: no listTaskQuestions / no seal before the quick finalize.
    await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1'), ans('q2')] })
    const afterSubmit = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    // In-tx reconcile created BOTH self entries and the consume confirmed them.
    expect(afterSubmit.length).toBe(2)
    expect(afterSubmit.every((e) => e.roleKind === 'self' && e.confirmation === 'confirmed')).toBe(
      true,
    )
    // The later LAZY reconcile (listTaskQuestions path) must NOT reset them to open.
    const roundRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    reconcileTaskQuestionsForRound(db, roundRows[0]!)
    const afterReconcile = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, clarifyNodeRunId))
    expect(afterReconcile.every((e) => e.confirmation === 'confirmed')).toBe(true)
    // Not re-dispatchable (dispatch skips confirmed) → no duplicate mint.
    const redispatch = await dispatchTaskQuestions(
      db,
      taskId,
      afterReconcile.map((e) => e.id),
      actor,
    )
    expect(redispatch.dispatchedEntryIds.length).toBe(0)
  })

  // step 3 (RFC-076 ordering preserved): after a quick-finalize the atomic tx leaves the rerun minted
  // (pending) + the session answered, and the clarify node is closed (done) AFTER — i.e. never
  // done-without-rerun. Locks the mint→write→close invariant across the async→sync-tx rewrite.
  test('step 3 — RFC-076: after quick-finalize, rerun(pending) + session(answered) + clarify(done)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't')],
    })
    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [ans('q1')],
    })
    // mint present (pending, clarify-answer, on the asking node).
    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.status).toBe('pending')
    expect(rerun?.rerunCause).toBe('clarify-answer')
    expect(rerun?.nodeId).toBe(P)
    // session answered.
    const sess = (
      await db
        .select()
        .from(clarifySessions)
        .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.status).toBe('answered')
    // clarify node closed (done) — the LAST step, after the rerun is committed.
    const clarifyRun = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId))
    )[0]
    expect(clarifyRun?.status).toBe('done')
  })

  // step 3 (source-level atomicity lock): the double-mint race close is structural (bun:sqlite single
  // thread + dbTxSync sync body), hard to exercise behaviorally. Bottom-line guard: submitClarifyAnswers
  // mints + flips inside a dbTxSync (NOT separate awaits). If a refactor reverts this to an async mint
  // the race reopens — this text assertion goes red. (CLAUDE.md source-level fallback pattern.)
  test('step 3 — submitClarifyAnswers lock/mint source order (race-close + conditional A≻B)', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/clarify.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export async function submitClarifyAnswers'))
    // (a) mint + flips inside the dbTxSync — closes the dispatch double-mint race (rerun committed
    // atomically with the session/round flips).
    expect(fn.includes('dbTxSync(db, (tx) =>')).toBe(true)
    const mintIdx = fn.indexOf('tx.insert(nodeRuns).values(rerunValues)')
    expect(mintIdx).toBeGreaterThan(fn.indexOf('dbTxSync(db, (tx) =>')) // mint inside the tx
    // (b) the per-task QUESTION-WRITE lock B wraps the critical section: claim + reciprocal precheck
    // live under it, BEFORE the rollback.
    const bLockIdx = fn.indexOf('getTaskQuestionWriteSem(taskRow.id).run')
    const claimIdx = fn.indexOf('lost the submit claim before rollback')
    const reciprocalIdx = fn.indexOf('hasOpenDispatchedEntryOnHome(')
    const rollbackIdx = fn.indexOf('rollbackNodeRunWorktrees(')
    expect(bLockIdx).toBeGreaterThan(0)
    expect(claimIdx).toBeGreaterThan(bLockIdx) // claim under the B lock
    expect(claimIdx).toBeLessThan(rollbackIdx) // claim BEFORE the rollback
    expect(reciprocalIdx).toBeGreaterThan(bLockIdx) // reciprocal precheck under B
    expect(reciprocalIdx).toBeLessThan(rollbackIdx) // reciprocal precheck BEFORE the rollback
    // (c) §5.2.14 review-11/12 conditional A ≻ B: the long worktree lock A is taken OUTER + ONLY when
    // a rollback runs (so the A-wait never holds B → no dispatch stall behind an agent run); the
    // no-rollback path takes B only (no A). Lock the exact branch.
    expect(
      fn.includes('if (needsRollback) await getTaskWriteSem(taskRow.id).run(runUnderQuestionLock)'),
    ).toBe(true)
    expect(fn.includes('else await runUnderQuestionLock()')).toBe(true)
    // the rollback runs UNDER A (no inner getTaskWriteSem around it — A is the outer wrapper).
    const rollbackBlock = fn.slice(rollbackIdx - 200, rollbackIdx)
    expect(rollbackBlock.includes('getTaskWriteSem')).toBe(false)
  })

  // finding 1 (regression ①): two CONCURRENT submitClarifyAnswers on the same awaiting_human session
  // (both pass the pre-tx read) must mint EXACTLY ONE clarify-answer rerun — the in-tx session CAS
  // makes the loser reject. (Outcome-deterministic regardless of await interleaving: one resolves,
  // one rejects, one rerun.)
  test('finding 1 — concurrent double-submit mints exactly ONE clarify-answer rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't')],
    })
    const results = await Promise.allSettled([
      submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1')] }),
      submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1')] }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictError)
    // Exactly ONE clarify-answer rerun on P — no double mint.
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === P && r.rerunCause === 'clarify-answer',
    )
    expect(reruns.length).toBe(1)
  })

  // 2nd-gate finding 2 (reciprocal in-flight check, PRECISE): an OPEN (unconsumed) DISPATCHED self
  // entry whose home == this home (a concurrent dispatch that won) blocks the quick-finalize mint.
  // Keyed on a DISPATCHED entry — NOT "any pending rerun" — so a prior round's quick continuation
  // (no dispatched entry) does NOT false-reject (that was the broad-check regression).
  test('finding 2 (reciprocal) — an OPEN dispatched self entry on the home blocks the quick-finalize mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't')],
    })
    // A separate (other-round) self entry, DISPATCHED with home P, whose rerun is in-flight (pending,
    // unconsumed) — the concurrent dispatch that already won the race for home P.
    const other = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('qx', 't')],
    })
    const dispatchedRerun = await seedRun(db, taskId, P, {
      status: 'pending',
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: other.intermediaryNodeRunId,
      questionId: 'qx',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: dispatchedRerun,
    })
    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    let caught: unknown
    try {
      await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1')] })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-quick-finalize-rerun-in-flight')
    // No SECOND rerun minted — the tx rolled back (the existing in-flight dispatched rerun stands).
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })

  // 2nd-gate finding 2 — the precise check does NOT false-reject a prior round's quick continuation
  // (a pending clarify-answer rerun on the home with NO dispatched entry): the legitimate sequential
  // multi-round flow proceeds. (This is the regression the broad "any pending rerun" check caused.)
  test('finding 2 (reciprocal) — a prior pending clarify-answer rerun WITHOUT a dispatched entry does NOT block', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const pRun = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't')],
    })
    // A pending clarify-answer rerun on (P, 0) from a prior quick continuation — NO dispatched entry.
    await seedRun(db, taskId, P, { status: 'pending', iteration: 0, rerunCause: 'clarify-answer' })
    // Must NOT throw the reciprocal conflict (no dispatched entry on the home).
    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [ans('q1')],
    })
    expect(rerunNodeRunId).toBeTruthy()
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
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: pRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
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
    // Fire both concurrently — the question-write lock serializes them.
    await Promise.allSettled([
      dispatchTaskQuestions(db, taskId, [q1!.id], actor),
      submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1'), ans('q2')] }),
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
//   ②(a) the answer MERGE (lockedIds) must run UNDER B, not from a pre-lock snapshot, else a
//         concurrent seal committed after the pre-lock read is overwritten (locked-answer data loss);
//   ①   the deferred-designer task_questions reconcile must be IN the cross flip tx (atomic), not a
//        post-lock reconcileTaskQuestionsForRound (answered-but-row-less window vs dispatch/park).
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

  // ②(a) self — the lockedIds read + the answer merge are INSIDE the B closure (after `.run(`), so a
  // seal committed before B is observed and its locked answer is kept (not clobbered by a stale merge).
  test('②(a) self — loadSealedQuestionIds + mergeSealedAnswers are INSIDE the B closure', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/clarify.ts'), 'utf8')
    const fn = fnBody(src, 'export async function submitClarifyAnswers')
    const bLockIdx = fn.indexOf('getTaskQuestionWriteSem(taskRow.id).run')
    expect(bLockIdx).toBeGreaterThan(0)
    expect(fn.indexOf('loadSealedQuestionIds(')).toBeGreaterThan(bLockIdx)
    expect(fn.indexOf('mergeSealedAnswers(')).toBeGreaterThan(bLockIdx)
  })

  // ②(a) cross — same: the merge runs under B (was computed from the pre-lock `row` snapshot).
  test('②(a) cross — loadSealedQuestionIds + mergeSealedAnswers are INSIDE the B closure', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/crossClarify.ts'), 'utf8')
    const fn = fnBody(src, 'export async function submitCrossClarifyAnswers')
    const bLockIdx = fn.indexOf('getTaskQuestionWriteSem(row.taskId).run')
    expect(bLockIdx).toBeGreaterThan(0)
    expect(fn.indexOf('loadSealedQuestionIds(')).toBeGreaterThan(bLockIdx)
    expect(fn.indexOf('mergeSealedAnswers(')).toBeGreaterThan(bLockIdx)
  })

  // ① cross — the deferred-designer reconcile (reconcileRoundEntriesTx gated on isDeferredDesignerPath)
  // is IN the flip tx, BEFORE the flip; the old post-lock reconcileTaskQuestionsForRound is GONE.
  test('① cross — deferred designer reconcile is IN the flip tx; no post-lock reconcile', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/crossClarify.ts'), 'utf8')
    const fn = fnBody(src, 'export async function submitCrossClarifyAnswers')
    const deferredIdx = fn.indexOf('isDeferredDesignerPath && roundRow')
    const flipIdx = fn.indexOf('flip cross_clarify_session → answered')
    expect(deferredIdx).toBeGreaterThan(0)
    expect(flipIdx).toBeGreaterThan(deferredIdx) // reconcile BEFORE the flip (same dbTxSync)
    expect(fn.includes('reconcileTaskQuestionsForRound(')).toBe(false) // no separate post-lock tx
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
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: D,
      sourceAgentNodeRunId: dRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't'), mkQ('q2', 't')],
    })
    // control-seal q1 = option A.
    await sealRoundQuestions({ db, originNodeRunId: clarifyNodeRunId, answers: [ans('q1')] })
    // quick-finalize, posting a DIFFERENT q1 (option B) + q2 (option A).
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [1],
          selectedOptionLabels: ['B'],
          customText: '',
        },
        ans('q2'),
      ],
    })
    const sess = (
      await db
        .select()
        .from(clarifySessions)
        .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
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
