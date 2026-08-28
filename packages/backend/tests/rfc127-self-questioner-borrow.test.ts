// RFC-127 self/questioner 借壳 → RFC-132 MOVE (去借壳).
//
// HISTORY: this file locked the IMMEDIATE (clarify-round) borrow path — the legacy quick channel
// minted the continuation on the asking HOME node, and a reassigned entry made the home BORROW the
// target's agent (resolveBorrowForNode → X.agentName, keyed on the round's RFC-070 consumption
// stamp). RFC-132 unifies every task on the deferred per-question dispatch
// (autoDispatchClarifyRound): a reassigned self/questioner answer now rides the DISPATCHED ledger,
// whose semantics are RFC-131 T4 MOVE — the rerun is minted ON the override target running its OWN
// agent, and resolveBorrowForNode resolves null everywhere on that path. Per RFC-132 design §6
// («Part0 move 保留、Part1 borrow 删»), the immediate-ledger borrow tests (resolution / Codex-P2
// multi-borrow + dual-ledger rejects / real-services + scheduler-e2e borrow) were DELETED with the
// legacy immediate mint; designer move coverage lives in rfc127-designer-borrow-dispatch.test.ts.
//
// What stays locked here:
//   * dispatched self/questioner entry reassigned to X → resolveBorrowForNode(X)=null AND
//     resolveBorrowForNode(home)=null — MOVE, no borrow, X runs its own agent.
//   * golden: dispatched self entry with NO override → null (home runs itself).
//   * scheduler converts a borrow ConflictError into a NODE-level failure (source lock) — the
//     conflict surface stays guarded while resolveBorrowForNode remains in the tree.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

// Monotonic ulids: several scenarios seed an asking run + a fresher rerun back-to-back; a
// monotonic factory guarantees the later-seeded row always sorts freshest (mirrors
// scheduler-clarify-dispatch.test.ts's note on same-ms ulid inversion).
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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

async function seedTask(db: DbClient, taskId: string, _opts: { deferred?: boolean } = {}) {
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

/** RFC-132 PR-B — seed an OPEN DISPATCHED self/questioner entry (dispatched_at set, trigger_run_id
 *  NULL ⇒ unbound/unconsumed, NO immediate continuation), reassigned to `override`. This is the
 *  PRODUCTION shape after PR-B: the quick channel auto-dispatches through dispatchTaskQuestions, which
 *  keys the ledger on the EFFECTIVE TARGET (override ?? default) and mints the rerun ON that target
 *  running its OWN agent — MOVE, not borrow (RFC-131 T4 去借壳). */
async function seedDispatchedSelfQEntry(
  db: DbClient,
  taskId: string,
  kind: 'self' | 'cross',
  override: string | null,
): Promise<{ home: string; intRunId: string }> {
  const home = kind === 'self' ? P : Q
  const asking = kind === 'self' ? P : Q
  const intermediary = kind === 'self' ? CL : CC
  const askingRunId = await seedRun(db, taskId, asking, { iteration: 0 })
  const intRunId = await seedRun(db, taskId, intermediary, { iteration: 0 })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind,
    askingNodeId: asking,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: intermediary,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: kind === 'cross' ? D : null,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([mkQ('q1', 't')]),
    answersJson: JSON.stringify([ans('q1')]),
    directive: 'continue',
    status: 'answered',
    createdAt: Date.now(),
  })
  await db.insert(taskQuestions).values({
    id: ulid(),
    taskId,
    originNodeRunId: intRunId,
    questionId: 'q1',
    questionTitle: 't',
    sourceKind: kind === 'self' ? 'self' : 'cross',
    roleKind: kind === 'self' ? 'self' : 'questioner',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: home,
    overrideTargetNodeId: override,
    dispatchedAt: Date.now(),
    dispatchedBy: 'u1',
    // trigger_run_id NULL ⇒ dispatched-but-unbound ⇒ open/unconsumed.
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return { home, intRunId }
}

// ---------------------------------------------------------------------------
// Part 0 (RFC-132 PR-B) — self/questioner via the DISPATCH path is MOVE, not borrow.
//
// Under the universal deferred model the quick channel auto-dispatches through dispatchTaskQuestions
// (no legacy immediate mint), so a reassigned self/questioner entry's ledger is the DEFERRED
// self/questioner ledger (dispatched_at + effectiveTarget), which is RFC-131 T4 去借壳: the rerun is
// minted ON the target node running its OWN agent. resolveBorrowForNode therefore returns null for
// BOTH the target (X runs itself) and the origin home (the run moved away). The immediate-ledger
// borrow tests that used to follow were deleted with the legacy immediate mint (RFC-132 §6).

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-132 PR-B — self/questioner via dispatch is MOVE (去借壳, not borrow)', () => {
  test('dispatched self entry reassigned to X → resolveBorrowForNode(X)=null (X runs its OWN agent)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'move-self')
    await seedDispatchedSelfQEntry(db, 'move-self', 'self', X)
    // X runs its own agent (MOVE) — NOT P borrowing X's brain (the pre-131 borrow).
    expect(await resolveBorrowForNode(db, 'move-self', X, 0, liveDef())).toBeNull()
    // the origin home P does not borrow — the run moved to X (its ledger is empty on P).
    expect(await resolveBorrowForNode(db, 'move-self', P, 0, liveDef())).toBeNull()
  })

  test('dispatched questioner entry reassigned to X → resolveBorrowForNode(X)=null (move)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'move-q')
    await seedDispatchedSelfQEntry(db, 'move-q', 'cross', X)
    expect(await resolveBorrowForNode(db, 'move-q', X, 0, liveDef())).toBeNull()
    expect(await resolveBorrowForNode(db, 'move-q', Q, 0, liveDef())).toBeNull()
  })

  test('golden: a dispatched self entry with NO override → resolveBorrowForNode(P)=null (P runs itself)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db, 'move-self-noov')
    // no reassign (override NULL): effectiveTarget == default == P → the rerun mints on P.
    await seedDispatchedSelfQEntry(db, 'move-self-noov', 'self', null)
    expect(await resolveBorrowForNode(db, 'move-self-noov', P, 0, liveDef())).toBeNull()
  })
})

// Source-level lock: the scheduler converts a borrow ConflictError into a NODE-level failure
// (resolveBorrowForNode runs before runOneNode's try block, so an unguarded throw would reject
// the whole scope tick → runTask fails the entire task).
describe('RFC-127 borrow conflict — scheduler node-level failure (source lock)', () => {
  test('runOneNode catches ConflictError from resolveBorrowForNode → kind:failed', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    expect(src).toMatch(/catch[\s\S]{0,200}ConflictError[\s\S]{0,80}kind: 'failed'/)
  })
})
