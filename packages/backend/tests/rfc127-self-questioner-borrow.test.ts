// RFC-127 self/questioner 借壳顶替 — the immediate (clarify-round) borrow path.
//
// designer 借壳 rides the DEFERRED dispatch ledger (dispatched_at + trigger_run_id),
// covered by rfc127-designer-borrow-dispatch.test.ts. self/questioner reruns are minted
// the instant the human answers (clarify.ts 'clarify-answer' on the asking node P;
// crossClarify mintQuestionerRerun 'cross-clarify-questioner-rerun' on the questioner)
// and NEVER touch dispatched_at — so their borrow consumption is ROUND-based: the entry's
// clarify round + its role's RFC-070 consumption stamp (self ⇒ consumed_by_consumer_run_id,
// questioner ⇒ consumed_by_questioner_run_id). This file locks resolveBorrowForNode's
// self/questioner branch:
//   * override → returns the borrowed node's agentName (the home node's continuation rerun
//     will run X — the scheduler→buildBorrowedAgent→spawn path is shared with designer and
//     proven by rfc127-designer-borrow-dispatch.test.ts).
//   * golden-lock: no override → null (home runs its own agent).
//   * consumed: once the continuation rerun lands done+output (round stamp set) → null, so
//     an unrelated future rerun on the same node does NOT keep borrowing.
//   * real-services integration: createClarifySession/createCrossClarifySession → reconcile
//     → reassign → submit (mints the continuation rerun) → resolveBorrowForNode returns X.
//   * scheduler e2e: a reassigned self continuation rerun ACTUALLY spawns the borrowed agent.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { markClarifyRoundsConsumedBy } from '../src/services/clarifyRounds'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { runTask } from '../src/services/scheduler'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

// Monotonic ulids: several scenarios seed an asking run + a fresher rerun back-to-back; a
// monotonic factory guarantees the later-seeded row always sorts freshest (mirrors
// scheduler-clarify-dispatch.test.ts's note on same-ms ulid inversion).
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// node ids + their agentNames in the frozen snapshot.
const P = 'P' // self-asking agent
const Q = 'Q' // cross questioner agent
const D = 'D' // cross designer agent
const X = 'X' // borrow target (a plain agent node)
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node
const P_AGENT = 'agent-p'
const Q_AGENT = 'agent-q'
const D_AGENT = 'agent-d'
const X_AGENT = 'borrow-x'

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: P, kind: 'agent-single', agentName: P_AGENT } as WorkflowNode,
    { id: Q, kind: 'agent-single', agentName: Q_AGENT } as WorkflowNode,
    { id: D, kind: 'agent-single', agentName: D_AGENT } as WorkflowNode,
    { id: X, kind: 'agent-single', agentName: X_AGENT } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_p_cl',
        source: { nodeId: P, portName: '__clarify__' },
        target: { nodeId: CL, portName: 'questions' },
      },
      {
        id: 'e_cl_p',
        source: { nodeId: CL, portName: 'response' },
        target: { nodeId: P, portName: '__clarify_response__' },
      },
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

async function seedTask(db: DbClient, taskId: string, opts: { deferred?: boolean } = {}) {
  await db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'rfc127-sq',
    description: '',
    definition: JSON.stringify(liveDef()),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc127-sq',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: JSON.stringify(liveDef()),
    repoPath: '/tmp/aw-rfc127-sq/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: opts.deferred ?? false,
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  opts: { status?: 'done' | 'pending' | 'failed'; withOutput?: boolean; iteration?: number } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: opts.status ?? 'done',
    retryIndex: 0,
    iteration: opts.iteration ?? 0,
    startedAt: Date.now(),
  })
  if (opts.withOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content: 'x' })
  }
  return id
}

/** Seed an answered self clarify round + N self task_questions (one per question), with a
 *  per-question override. The ASKING run is seeded at `askingIteration` (self rounds project
 *  loop_iter=0, so the asking run's iteration is the only carrier of the wrapper-loop index —
 *  P2-3). Returns the round's intermediary (origin) run id. */
async function seedSelfRoundMulti(
  db: DbClient,
  taskId: string,
  opts: {
    questions: Array<{ qid: string; override: string | null }>
    askingIteration?: number
    consumedRunId?: string | null
  },
): Promise<string> {
  const it = opts.askingIteration ?? 0
  const askingRunId = await seedRun(db, taskId, P, { iteration: it })
  const intRunId = await seedRun(db, taskId, CL, { iteration: it })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: P,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: null,
    loopIter: 0, // self ALWAYS projects loop_iter 0 (taskQuestions.ts) — the bug surface for P2-3
    iteration: 0,
    questionsJson: JSON.stringify(opts.questions.map((q) => mkQ(q.qid, 't'))),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.qid))),
    status: 'answered',
    createdAt: Date.now(),
    consumedByConsumerRunId: opts.consumedRunId ?? null,
  })
  for (const q of opts.questions) {
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId: intRunId,
      questionId: q.qid,
      questionTitle: 't',
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: P,
      overrideTargetNodeId: q.override,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  return intRunId
}

/** Seed an OPEN dispatched designer override entry whose graph-designer home is `designerNode`
 *  (deferred ledger): a cross round → `designerNode`, reassigned to `override`, dispatched
 *  (dispatched_at set) and unbound (trigger_run_id NULL ⇒ unconsumed). Used for the dual-ledger
 *  conflict (P2-2) — pass designerNode=P to put BOTH ledgers on the same home. */
async function seedDispatchedDesignerEntry(
  db: DbClient,
  taskId: string,
  designerNode: string,
  override: string,
): Promise<void> {
  const askingRunId = await seedRun(db, taskId, Q)
  const intRunId = await seedRun(db, taskId, CC)
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'cross',
    askingNodeId: Q,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: designerNode,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([mkQ('dq', 't')]),
    answersJson: JSON.stringify([ans('dq')]),
    directive: 'continue',
    status: 'answered',
    createdAt: Date.now(),
  })
  await db.insert(taskQuestions).values({
    id: ulid(),
    taskId,
    originNodeRunId: intRunId,
    questionId: 'dq',
    questionTitle: 't',
    sourceKind: 'cross',
    roleKind: 'designer',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: designerNode,
    overrideTargetNodeId: override,
    dispatchedAt: Date.now(),
    dispatchedBy: 'u1',
    // trigger_run_id NULL ⇒ dispatched-but-unbound ⇒ open/unconsumed.
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

/** Seed an answered self clarify round + its reconciled self task_question (default=P). */
async function seedSelfEntry(
  db: DbClient,
  taskId: string,
  opts: { override: string | null; consumedRunId?: string | null },
): Promise<string> {
  const askingRunId = await seedRun(db, taskId, P)
  const intRunId = await seedRun(db, taskId, CL)
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: P,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([mkQ('q1', 't')]),
    answersJson: JSON.stringify([ans('q1')]),
    status: 'answered',
    createdAt: Date.now(),
    consumedByConsumerRunId: opts.consumedRunId ?? null,
  })
  const entryId = ulid()
  await db.insert(taskQuestions).values({
    id: entryId,
    taskId,
    originNodeRunId: intRunId,
    questionId: 'q1',
    questionTitle: 't',
    sourceKind: 'self',
    roleKind: 'self',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: P,
    overrideTargetNodeId: opts.override,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return entryId
}

/** Seed an answered cross round + its reconciled questioner task_question (default=Q). */
async function seedQuestionerEntry(
  db: DbClient,
  taskId: string,
  opts: { override: string | null; consumedRunId?: string | null },
): Promise<string> {
  const askingRunId = await seedRun(db, taskId, Q)
  const intRunId = await seedRun(db, taskId, CC)
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'cross',
    askingNodeId: Q,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: D,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([mkQ('q1', 't')]),
    answersJson: JSON.stringify([ans('q1')]),
    directive: 'continue',
    status: 'answered',
    createdAt: Date.now(),
    consumedByQuestionerRunId: opts.consumedRunId ?? null,
  })
  const entryId = ulid()
  await db.insert(taskQuestions).values({
    id: entryId,
    taskId,
    originNodeRunId: intRunId,
    questionId: 'q1',
    questionTitle: 't',
    sourceKind: 'cross',
    roleKind: 'questioner',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: Q,
    overrideTargetNodeId: opts.override,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return entryId
}

// ---------------------------------------------------------------------------
// Part 1 — resolveBorrowForNode self/questioner resolution (direct seed).
// ---------------------------------------------------------------------------
describe('RFC-127 resolveBorrowForNode — self/questioner (round-based)', () => {
  test('self override X → borrows X.agentName on the home node P', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't1')
    await seedSelfEntry(db, 't1', { override: X })
    expect(await resolveBorrowForNode(db, 't1', P, 0, liveDef())).toBe(X_AGENT)
  })

  test('questioner override X → borrows X.agentName on the home node Q', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't2')
    await seedQuestionerEntry(db, 't2', { override: X })
    expect(await resolveBorrowForNode(db, 't2', Q, 0, liveDef())).toBe(X_AGENT)
  })

  test('golden-lock: self with NO override → null (home runs its own agent)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't3')
    await seedSelfEntry(db, 't3', { override: null })
    expect(await resolveBorrowForNode(db, 't3', P, 0, liveDef())).toBeNull()
  })

  test('golden-lock: questioner with NO override → null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't4')
    await seedQuestionerEntry(db, 't4', { override: null })
    expect(await resolveBorrowForNode(db, 't4', Q, 0, liveDef())).toBeNull()
  })

  test('consumed: self continuation rerun done+output (round stamped) → borrow drops to null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't5')
    const consumed = await seedRun(db, 't5', P, { status: 'done', withOutput: true })
    await seedSelfEntry(db, 't5', { override: X, consumedRunId: consumed })
    expect(await resolveBorrowForNode(db, 't5', P, 0, liveDef())).toBeNull()
  })

  test('consumed: questioner continuation rerun done+output → borrow drops to null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't6')
    const consumed = await seedRun(db, 't6', Q, { status: 'done', withOutput: true })
    await seedQuestionerEntry(db, 't6', { override: X, consumedRunId: consumed })
    expect(await resolveBorrowForNode(db, 't6', Q, 0, liveDef())).toBeNull()
  })

  test('defensive: stamp points at a done run WITHOUT output → still unconsumed (keeps borrowing)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't7')
    const noOut = await seedRun(db, 't7', P, { status: 'done', withOutput: false })
    await seedSelfEntry(db, 't7', { override: X, consumedRunId: noOut })
    expect(await resolveBorrowForNode(db, 't7', P, 0, liveDef())).toBe(X_AGENT)
  })

  test('isolation: a self override on P does NOT borrow when resolving a different node', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't8')
    await seedSelfEntry(db, 't8', { override: X })
    // Q has no entry → no borrow there even though P's entry exists.
    expect(await resolveBorrowForNode(db, 't8', Q, 0, liveDef())).toBeNull()
  })

  test('isolation: a self override to the home itself (X===default) is not a borrow', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 't9')
    // override === default (P) ⇒ borrowAgentNode is null ⇒ no borrow (runs P's own agent).
    await seedSelfEntry(db, 't9', { override: P })
    expect(await resolveBorrowForNode(db, 't9', P, 0, liveDef())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Codex impl-gate P2 regressions (3 边角正确性 bugs in resolveImmediateBorrowForNode).
// ---------------------------------------------------------------------------
describe('RFC-127 borrow — Codex P2 regressions', () => {
  // P2-3: self clarify rounds project loop_iter=0, but the scheduler resolves the borrow with
  // node_runs.iteration (the loop index). A `loop_iter == iteration` filter therefore MISSES a
  // reassigned self entry at wrapper-loop iteration ≥ 1 → the home agent ran instead of borrow X.
  // The fix matches the round's ASKING run iteration; this locks it stays fixed.
  test('P2-3: reassigned self at loop iteration ≥ 1 still borrows (loop_iter=0 projection)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-3')
    // asking run at iteration 1; the self round loop_iter is HARDCODED 0 (the bug surface).
    await seedSelfRoundMulti(db, 'p2-3', {
      questions: [{ qid: 'q1', override: X }],
      askingIteration: 1,
    })
    // The OLD `loop_iter == iteration` filter resolved null here (0 != 1) → home agent. Now: X.
    expect(await resolveBorrowForNode(db, 'p2-3', P, 1, liveDef())).toBe(X_AGENT)
    // And it does NOT leak into an unrelated iteration (no round there).
    expect(await resolveBorrowForNode(db, 'p2-3', P, 2, liveDef())).toBeNull()
  })

  test('P2-3: loop-iter≥1 golden-lock — no override at iter 1 → null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-3b')
    await seedSelfRoundMulti(db, 'p2-3b', {
      questions: [{ qid: 'q1', override: null }],
      askingIteration: 1,
    })
    expect(await resolveBorrowForNode(db, 'p2-3b', P, 1, liveDef())).toBeNull()
  })

  // P2-1: one self/questioner continuation rerun re-runs the home ONCE → it borrows ONE agent.
  // A round whose questions are reassigned to two different agents (or a mix of borrow + self) is
  // ambiguous; the old code `.find()`-picked the first silently. Now it must REJECT.
  test('P2-1: a self round reassigned to TWO agents → rejected (not silently first-picked)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-1a')
    await seedSelfRoundMulti(db, 'p2-1a', {
      questions: [
        { qid: 'q1', override: X },
        { qid: 'q2', override: D }, // a DIFFERENT agent node
      ],
    })
    await expect(resolveBorrowForNode(db, 'p2-1a', P, 0, liveDef())).rejects.toThrow(
      /multi-borrow|conflicting/i,
    )
  })

  test('P2-1: a self round with a borrow + a run-self mix → rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-1b')
    await seedSelfRoundMulti(db, 'p2-1b', {
      questions: [
        { qid: 'q1', override: X }, // borrow X
        { qid: 'q2', override: null }, // run self
      ],
    })
    await expect(resolveBorrowForNode(db, 'p2-1b', P, 0, liveDef())).rejects.toThrow(
      /multi-borrow|conflicting/i,
    )
  })

  test('P2-1: a round uniformly reassigned to ONE agent (both questions → X) still resolves to X', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-1c')
    await seedSelfRoundMulti(db, 'p2-1c', {
      questions: [
        { qid: 'q1', override: X },
        { qid: 'q2', override: X },
      ],
    })
    expect(await resolveBorrowForNode(db, 'p2-1c', P, 0, liveDef())).toBe(X_AGENT)
  })

  // P2-2: the same home with BOTH an open self/questioner reassignment AND an open dispatched
  // designer reassignment is ambiguous (the scheduler can't tell which ledger the rerun belongs
  // to). Must REJECT rather than let the immediate ledger silently win.
  test('P2-2: same home, self ledger + designer ledger (DIFFERENT agents) → rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-2', { deferred: true })
    // self reassignment on P → X (immediate ledger) ...
    await seedSelfRoundMulti(db, 'p2-2', { questions: [{ qid: 'q1', override: X }] })
    // ... AND a dispatched designer reassignment on the SAME home P → D (designer ledger).
    await seedDispatchedDesignerEntry(db, 'p2-2', P, D)
    await expect(resolveBorrowForNode(db, 'p2-2', P, 0, liveDef())).rejects.toThrow(
      /duplicate execution/i,
    )
  })

  // Codex impl-gate round 2: even when both ledgers borrow the SAME agent, the overlap is a
  // duplicate-EXECUTION hazard — they are two separate pending node_runs on the home (the
  // designer in-flight gate doesn't see the immediate continuation), and runOneNode binds by
  // node not by ledger, so the first run stamps both ledgers and the other runs stale. Reject
  // regardless of agent match (round 1's same-agent fast path was unsafe).
  test('P2-2: same home, both ledgers → SAME agent → STILL rejected (duplicate-execution hazard)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-2same', { deferred: true })
    await seedSelfRoundMulti(db, 'p2-2same', { questions: [{ qid: 'q1', override: X }] })
    await seedDispatchedDesignerEntry(db, 'p2-2same', P, X)
    await expect(resolveBorrowForNode(db, 'p2-2same', P, 0, liveDef())).rejects.toThrow(
      /duplicate execution/i,
    )
  })

  // RFC-128 P5-BC (Codex impl-gate run-self fix, §5.2.3④): an OPEN RUN-SELF immediate ledger (a
  // self round answered-unconsumed with NO override → a pending self continuation that runs P's
  // OWN agent) + an open designer borrow on the SAME home P are STILL two separate pending reruns
  // with mutually-exclusive causes → duplicate execution → REJECT. The earlier code treated
  // run-self as "not a ledger" (returned the designer's agent), which would mis-run the self
  // continuation under the designer's borrowed agent. (Was: "designer ledger ALONE ... resolves";
  // that asserted the latent bug. Normal designer dispatch — no self round on the home — is
  // unaffected: the immediate ledger is then genuinely CLOSED, so the designer resolves alone.)
  test('P2-2: open RUN-SELF immediate ledger + same-home designer borrow → rejected (run-self counts)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-2b', { deferred: true })
    // Open run-self immediate ledger on P (answered self round, NO override) ...
    await seedSelfRoundMulti(db, 'p2-2b', { questions: [{ qid: 'q1', override: null }] })
    // ... AND an open designer borrow on the SAME home P → two open ledgers → reject.
    await seedDispatchedDesignerEntry(db, 'p2-2b', P, D)
    await expect(resolveBorrowForNode(db, 'p2-2b', P, 0, liveDef())).rejects.toThrow(
      /duplicate execution/i,
    )
  })

  // Companion golden-lock: a designer borrow on a home with NO self round (immediate ledger
  // genuinely CLOSED) resolves alone — the run-self fix does NOT over-reject normal dispatch.
  test('P2-2: designer borrow on a home with NO self round → resolves alone (immediate closed)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'p2-2c', { deferred: true })
    await seedDispatchedDesignerEntry(db, 'p2-2c', D, X) // designer home D, borrow X; no self on D
    expect(await resolveBorrowForNode(db, 'p2-2c', D, 0, liveDef())).toBe(X_AGENT)
  })
})

// Source-level lock: the scheduler converts a borrow ConflictError into a NODE-level failure
// (resolveBorrowForNode runs before runOneNode's try block, so an unguarded throw would reject
// the whole scope tick → runTask fails the entire task).
describe('RFC-127 borrow conflict — scheduler node-level failure (source lock)', () => {
  test('runOneNode catches ConflictError from resolveBorrowForNode → kind:failed', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toMatch(/catch[\s\S]{0,200}ConflictError[\s\S]{0,80}kind: 'failed'/)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — real-services integration: the actual immediate flow drives the borrow.
// ---------------------------------------------------------------------------
describe('RFC-127 self/questioner borrow — real-services integration', () => {
  test('self: createSession → reconcile → reassign X → submit → resolveBorrowForNode(P)=X; consume → null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'int-self')
    const askingRunId = await seedRun(db, 'int-self', P)
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId: 'int-self',
      sourceAgentNodeId: P,
      sourceAgentNodeRunId: askingRunId,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1', 't')],
    })
    const selfEntry = (await listTaskQuestions(db, 'int-self')).find((e) => e.roleKind === 'self')!
    expect(selfEntry.defaultTargetNodeId).toBe(P)
    await reassignTaskQuestion(db, selfEntry.id, X, actor) // any role now reassignable (T4)
    await submitClarifyAnswers({ db, clarifyNodeRunId, answers: [ans('q1')] })

    // The continuation rerun is minted (clarify-answer on P); the round is answered but
    // not yet consumed → the borrow resolves to X.
    expect(await resolveBorrowForNode(db, 'int-self', P, 0, liveDef())).toBe(X_AGENT)

    // Drive the continuation rerun to done+output and stamp consumption (production path).
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, 'int-self'))
    const rerun = runs.find((r) => r.rerunCause === 'clarify-answer')!
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, rerun.id))
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: rerun.id, portName: 'result', content: 'r' })
    await markClarifyRoundsConsumedBy(db, {
      id: rerun.id,
      taskId: 'int-self',
      nodeId: P,
      shardKey: null,
    })

    // Consumed → an unrelated future rerun on P runs P's own agent (no stale borrow).
    expect(await resolveBorrowForNode(db, 'int-self', P, 0, liveDef())).toBeNull()
  })

  test('questioner: createCrossSession → reconcile → reassign X → submit(questioner-scoped) → resolveBorrowForNode(Q)=X', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'int-q')
    const qRunId = await seedRun(db, 'int-q', Q)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId: 'int-q',
      crossClarifyNodeId: CC,
      sourceQuestionerNodeId: Q,
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: D,
      loopIter: 0,
      questions: [mkQ('q1', 't')],
    })
    const qEntry = (await listTaskQuestions(db, 'int-q')).find((e) => e.roleKind === 'questioner')!
    expect(qEntry.defaultTargetNodeId).toBe(Q)
    await reassignTaskQuestion(db, qEntry.id, X, actor)
    // questioner-scoped ⇒ the questioner continue rerun is minted (fast path).
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      questionScopes: { q1: 'questioner' },
    })
    expect(await resolveBorrowForNode(db, 'int-q', Q, 0, liveDef())).toBe(X_AGENT)
  })
})

// ---------------------------------------------------------------------------
// Part 3 — scheduler e2e: the reassigned self continuation rerun ACTUALLY spawns X.
// ---------------------------------------------------------------------------
interface RunHarness {
  db: DbClient
  appHome: string
  worktreePath: string
  argvLog: string
  cleanup: () => void
}

function buildRunHarness(): RunHarness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc127-sq-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    argvLog,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const old = prev[k]
      if (old === undefined) delete process.env[k]
      else process.env[k] = old
    }
  })
}

function readSpawnedAgents(path: string): string[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).agent as string)
}

async function seedRunnableAgent(db: DbClient, name: string): Promise<void> {
  await createAgent(db, {
    name,
    description: '',
    outputs: ['result'],
    outputKinds: { result: 'markdown' },
    readonly: true,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

async function insertRunnableTask(h: RunHarness, taskId: string): Promise<void> {
  await h.db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'rfc127-sq-e2e',
    description: '',
    definition: JSON.stringify(liveDef()),
    version: 1,
    schemaVersion: 4,
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'rfc127-sq-e2e',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: JSON.stringify(liveDef()),
    repoPath: '/tmp/aw-rfc127-sq/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: false,
  })
}

async function runSchedulerOnce(h: RunHarness, taskId: string) {
  await withEnv(
    {
      MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvLog,
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
    },
    () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        defaultNodeRetries: 0,
      }),
  )
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-127 self borrow — scheduler e2e (续跑实际跑 X)', () => {
  test('a reassigned self continuation rerun spawns the borrowed agent X, not P', async () => {
    const h = buildRunHarness()
    try {
      const taskId = 'e2e-self'
      await insertRunnableTask(h, taskId)
      await seedRunnableAgent(h.db, P_AGENT)
      await seedRunnableAgent(h.db, X_AGENT)
      const askingRunId = await seedRun(h.db, taskId, P)
      const { clarifyNodeRunId } = await createClarifySession({
        db: h.db,
        taskId,
        sourceAgentNodeId: P,
        sourceAgentNodeRunId: askingRunId,
        sourceShardKey: null,
        clarifyNodeId: CL,
        iterationIndex: 0,
        questions: [mkQ('q1', 't')],
      })
      const selfEntry = (await listTaskQuestions(h.db, taskId)).find((e) => e.roleKind === 'self')!
      await reassignTaskQuestion(h.db, selfEntry.id, X, actor)
      // directive 'stop' lifts the self-clarify mandatory-ask-back so the borrowed rerun
      // emits <workflow-output> and completes (the borrow itself is directive-independent).
      await submitClarifyAnswers({
        db: h.db,
        clarifyNodeRunId,
        answers: [ans('q1')],
        directive: 'stop',
      })
      await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

      await runSchedulerOnce(h, taskId)

      // The home node P's continuation rerun ran the BORROWED agent X (not P's own agent).
      const spawned = readSpawnedAgents(h.argvLog)
      expect(spawned).toContain(X_AGENT)
      expect(spawned).not.toContain(P_AGENT)
      // The run is on node P (借壳: node_id=P) and reached done with P's output port.
      const pRuns = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, P)))
      const rerun = pRuns.find((r) => r.rerunCause === 'clarify-answer')!
      expect(rerun.status).toBe('done')
    } finally {
      h.cleanup()
    }
  })
})
