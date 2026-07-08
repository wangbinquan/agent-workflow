// RFC-132 PR-1 / T2 — selectAgentQueue + bindTriggerRun (the unified selection + derived-aging
// helper, DRY-extracted from buildClarifyNodeQueueContext ≈ buildNodeQueueExternalFeedback).
//
// Locks the extracted contract so PR-2 (T3) can route both legacy injectors through it without
// drift:
//   - ONE query, ALL roles (self/questioner/designer) projected by effectiveTarget(override??default)
//     — the "consumerKind 消失" of design §2 (a node that is both self-asker AND designer sees both).
//   - sealed OR manual filter (manual §15 has no seal but still injects its body).
//   - RFC-131 derived aging (isTargetNodeConsumed) as the SOLE criterion: done+output ages;
//     done-no-output / failed do NOT age; a round-N+1 entry bound after a prior output is NOT falsely
//     aged (trigger id-order anchor); review-superseded canceled+output ages.
//   - bindTriggerRun is an independent write that only stamps rows not already pinned to this run.
//
// selectAgentQueue is UNWIRED in PR-1 (no scheduler caller); these are direct DB fixtures.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
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
import { bindTriggerRun, selectAgentQueue } from '../src/services/clarifyQueue'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const P = 'P' // self-asking agent / consumer
const Q = 'Q' // cross questioner agent / consumer
const D = 'D' // designer agent / consumer
const X = 'X' // override target
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node

function opt(label: string) {
  return { label, description: '', recommended: false, recommendationReason: '' }
}
function mkQ(id: string, title: string): ClarifyQuestion {
  return { id, title, kind: 'single', recommended: false, options: [opt('A'), opt('B')] }
}
function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-rfc132',
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
  over: {
    status?: string
    iteration?: number
    hasOutput?: boolean
    errorMessage?: string
    supersededByReview?: 'iterated' | 'rejected'
  } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: over.iteration ?? 0,
    ...(over.errorMessage ? { errorMessage: over.errorMessage } : {}),
    ...(over.supersededByReview ? { supersededByReview: over.supersededByReview } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

/** Seed an answered clarify round; returns its intermediary node_run id (= entries' originNodeRunId). */
async function seedAnsweredRound(
  db: DbClient,
  taskId: string,
  opts: {
    kind: 'self' | 'cross'
    askingNodeId: string
    questions: ClarifyQuestion[]
    status?: 'answered' | 'awaiting_human' | 'canceled' | 'abandoned'
    iteration?: number
    noAnswers?: boolean
  },
): Promise<string> {
  const askingRunId = await seedRun(db, taskId, opts.askingNodeId, {
    status: 'awaiting_human',
    iteration: opts.iteration ?? 0,
  })
  const intRunId = await seedRun(db, taskId, opts.kind === 'self' ? CL : CC, {
    status: 'awaiting_human',
  })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: opts.kind,
    askingNodeId: opts.askingNodeId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: opts.kind === 'self' ? CL : CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: opts.kind === 'cross' ? D : null,
    iteration: opts.iteration ?? 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: opts.noAnswers ? null : JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: opts.status ?? 'answered',
    answeredAt: Date.now(),
  })
  return intRunId
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  sourceKind?: 'self' | 'cross' | 'manual'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  sealed?: boolean
  dispatchedAt?: number | null
  triggerRunId?: string | null
  manualTitle?: string | null
  manualBody?: string | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  const sourceKind = e.sourceKind ?? (e.roleKind === 'self' ? 'self' : 'cross')
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: e.questionId,
    sourceKind,
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: e.sealed ? Date.now() : null,
    sealedBy: e.sealed ? 'u1' : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    triggerRunId: e.triggerRunId ?? null,
    manualTitle: e.manualTitle ?? null,
    manualBody: e.manualBody ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

function entryRow(db: DbClient, id: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ===========================================================================
// selectAgentQueue — selection + projection + resolution
// ===========================================================================
describe('RFC-132 T2 — selectAgentQueue selection', () => {
  test('positive: a dispatched+sealed self entry resolves to a render-ready Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'DB choice')],
    })
    const rerun = await seedRun(db, taskId, P, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const q = await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: rerun })
    expect(q).toHaveLength(1)
    const render = q[0]!.render
    expect('question' in render && render.question.title).toBe('DB choice')
    expect('question' in render && render.answer?.selectedOptionLabels).toEqual(['A'])
  })

  test('unified query: self + designer entries on the SAME node come back in ONE queue (consumerKind 消失)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Node D self-clarifies AND is the designer — both roles project to D.
    const selfOrigin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: D,
      questions: [mkQ('sq', 'SELF-Q')],
    })
    const crossOrigin = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('dq', 'DESIGNER-Q')],
    })
    const rerun = await seedRun(db, taskId, D, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: selfOrigin,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    await insertEntry(db, taskId, {
      originNodeRunId: crossOrigin,
      questionId: 'dq',
      roleKind: 'designer',
      defaultTargetNodeId: D,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    const q = await selectAgentQueue({ db, taskId, consumerNodeId: D, dispatchedRunId: rerun })
    expect(q.map((e) => e.roleKind).sort()).toEqual(['designer', 'self'])
  })

  test('sealed 过滤: a dispatched but UNSEALED non-manual entry is excluded', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
      status: 'awaiting_human',
    })
    const rerun = await seedRun(db, taskId, P, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false, // NOT sealed
      dispatchedAt: Date.now(),
    })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: rerun }),
    ).toHaveLength(0)
  })

  test('manual 无 seal 仍入选: a dispatched manual (§15) entry with no seal injects its body', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const rerun = await seedRun(db, taskId, D, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: ulid(), // §15 H4 synthetic origin — no clarify round
      questionId: ulid(),
      roleKind: 'designer',
      sourceKind: 'manual',
      defaultTargetNodeId: D,
      sealed: false, // manual carries no seal
      dispatchedAt: Date.now(),
      manualTitle: 'Deadline',
      manualBody: 'Ship by Friday.',
    })
    const q = await selectAgentQueue({ db, taskId, consumerNodeId: D, dispatchedRunId: rerun })
    expect(q).toHaveLength(1)
    const render = q[0]!.render
    expect('manualBody' in render && render.manualBody).toBe('Ship by Friday.')
  })

  test('not-dispatched entry is excluded (park state)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    const rerun = await seedRun(db, taskId, P, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: null, // sealed but NOT dispatched
    })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: rerun }),
    ).toHaveLength(0)
  })

  test('effectiveTarget(override ?? default) projection: override wins, default ignored when override set', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('q1', 'REASSIGNED')],
    })
    const rerunX = await seedRun(db, taskId, X, { status: 'running' })
    const rerunP = await seedRun(db, taskId, P, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: P, // graph default P ...
      overrideTargetNodeId: X, // ... but reassigned to X
      sealed: true,
      dispatchedAt: Date.now(),
    })
    // Consumer X (the override) sees it.
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: X, dispatchedRunId: rerunX }),
    ).toHaveLength(1)
    // Consumer P (the default) does NOT — override supersedes default.
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: rerunP }),
    ).toHaveLength(0)
  })

  test('unrenderable: a dispatched+sealed entry whose round was canceled is dropped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
      status: 'canceled',
    })
    const rerun = await seedRun(db, taskId, P, { status: 'running' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
    })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: rerun }),
    ).toHaveLength(0)
  })
})

// ===========================================================================
// selectAgentQueue — RFC-131 derived aging (sole criterion)
// ===========================================================================
describe('RFC-132 T2 — selectAgentQueue derived aging', () => {
  test('done+output → aged (excluded)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'AGED')],
    })
    const prodRerun = await seedRun(db, taskId, P, { status: 'done', hasOutput: true })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prodRerun,
    })
    const laterRerun = await seedRun(db, taskId, P, { status: 'running' })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: laterRerun }),
    ).toHaveLength(0)
  })

  test('done WITHOUT output → NOT aged (still injected)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'KEPT')],
    })
    const doneNoOut = await seedRun(db, taskId, P, { status: 'done', hasOutput: false })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: doneNoOut,
    })
    const laterRerun = await seedRun(db, taskId, P, { status: 'running' })
    const q = await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: laterRerun })
    expect(q).toHaveLength(1)
  })

  test('failed (even with stray output) → NOT aged (revivable)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'REVIVE')],
    })
    const failedRerun = await seedRun(db, taskId, P, { status: 'failed', hasOutput: true })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: failedRerun,
    })
    const reviveRerun = await seedRun(db, taskId, P, { status: 'running' })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: reviveRerun }),
    ).toHaveLength(1)
  })

  test('round N+1 id-order anchor: a new entry bound AFTER a prior output is NOT falsely aged', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Round 1 — trigger = prodRerun (done+output) → aged.
    const r1 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 0,
      questions: [mkQ('r1q', 'ROUND1-AGED')],
    })
    const prodRerun = await seedRun(db, taskId, P, { status: 'done', hasOutput: true })
    await insertEntry(db, taskId, {
      originNodeRunId: r1,
      questionId: 'r1q',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: prodRerun,
    })
    // Round 2 — trigger = curRerun minted AFTER the output → its id > prodRerun.
    const r2 = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      iteration: 1,
      questions: [mkQ('r2q', 'ROUND2-FRESH')],
    })
    const curRerun = await seedRun(db, taskId, P, { status: 'running' })
    const r2eid = await insertEntry(db, taskId, {
      originNodeRunId: r2,
      questionId: 'r2q',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: curRerun,
    })
    const q = await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: curRerun })
    // Round 1 aged (trigger=prodRerun done+output, id>=trigger); round 2 kept (prodRerun.id<curRerun).
    expect(q.map((e) => e.id)).toEqual([r2eid])
  })

  test('review-superseded canceled+output → aged (design §74: reject flips done+output to canceled)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'SUPERSEDED')],
    })
    const superseded = await seedRun(db, taskId, P, {
      status: 'canceled',
      hasOutput: true,
      // RFC-145：老化判据读结构化列；errorMessage 仅人读 breadcrumb。
      supersededByReview: 'rejected',
      errorMessage: 'superseded-by-review-rejected: Replaced by retry_index 1',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: superseded,
    })
    const laterRerun = await seedRun(db, taskId, P, { status: 'running' })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: laterRerun }),
    ).toHaveLength(0)
  })

  test('plain canceled (no review marker) + output → NOT aged', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'PLAIN-CANCEL')],
    })
    const canceled = await seedRun(db, taskId, P, { status: 'canceled', hasOutput: true })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: canceled,
    })
    const laterRerun = await seedRun(db, taskId, P, { status: 'running' })
    expect(
      await selectAgentQueue({ db, taskId, consumerNodeId: P, dispatchedRunId: laterRerun }),
    ).toHaveLength(1)
  })
})

// ===========================================================================
// bindTriggerRun — independent write
// ===========================================================================
describe('RFC-132 T2 — bindTriggerRun', () => {
  test('binds only rows NOT already pinned to this run (unbound + earlier-lineage rebind)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('a', 't'), mkQ('b', 't'), mkQ('c', 't')],
    })
    const thisRun = await seedRun(db, taskId, P, { status: 'running' })
    const otherRun = await seedRun(db, taskId, P, { status: 'done' })
    const unbound = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'a',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: null,
    })
    const boundElsewhere = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'b',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: otherRun,
    })
    const alreadyBound = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'c',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: thisRun,
    })
    const before = (await entryRow(db, alreadyBound))[0]!.updatedAt

    const bound = await bindTriggerRun(db, [unbound, boundElsewhere, alreadyBound], thisRun)
    expect(bound.sort()).toEqual([unbound, boundElsewhere].sort())

    // All three now point at thisRun ...
    expect((await entryRow(db, unbound))[0]!.triggerRunId).toBe(thisRun)
    expect((await entryRow(db, boundElsewhere))[0]!.triggerRunId).toBe(thisRun)
    expect((await entryRow(db, alreadyBound))[0]!.triggerRunId).toBe(thisRun)
    // ... but the already-pinned row was NOT rewritten (no updated_at churn).
    expect((await entryRow(db, alreadyBound))[0]!.updatedAt).toBe(before)
  })

  test('empty id list → no-op, returns []', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const run = await seedRun(db, taskId, P, { status: 'running' })
    expect(await bindTriggerRun(db, [], run)).toEqual([])
  })
})
