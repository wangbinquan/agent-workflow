// RFC-128 P5-D — quick-channel seal + AUTODISPATCH (the FINAL P5 phase).
//
// §5.2.7 P5b single-path: on a DEFERRED task the quick channel (defer=false) does NOT mint an
// immediate continuation; it seals the round + AUTO-triggers the SAME per-question dispatch the
// board uses (autoDispatchClarifyRound = sealRoundQuestions → dispatchTaskQuestions, sequential, no
// lock-B reentry). `defer` only chooses AUTO vs MANUAL triggering of the ONE dispatch path. A
// NON-deferred task keeps the legacy immediate mint (submitClarifyAnswers / submitCrossClarify-
// Answers, byte-for-byte unchanged — golden-lock).
//
// This locks: AC-9 fast-path seal→auto continuation; golden-lock cause alignment (self→clarify-answer
// / questioner→cross-clarify-questioner-rerun) + full-round injection; per-round single path (auto
// and manual never double-dispatch); RFC-125 single-path invariant (flag never flipped); lock
// non-reentry; the P5-0 guard relationship (lifted on deferred, fires only on the non-deferred
// control channel).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { gitStashSnapshot, runGit } from '../src/util/git'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  broadcastSelfClarifyAnsweredForRound,
  createClarifySession,
  submitClarifyAnswers,
} from '../src/services/clarify'
import { broadcastCrossClarifyAnsweredForRound } from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import {
  loadUndispatchedDesignerTargets,
  loadUndispatchedParkTargets,
  loadUndispatchedSelfQuestionerTargets,
} from '../src/services/taskQuestions'
import { buildClarifyNodeQueueContext, buildPromptContext } from '../src/services/clarifyRounds'
import { getNodeClarifyDirectiveRow } from '../src/services/taskClarifyDirective'
import { getTaskQuestionWriteSem } from '../src/services/taskWriteLocks'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const P = 'P' // self-asking agent
const Q = 'Q' // cross questioner agent
const D = 'D' // cross designer agent
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: P, kind: 'agent-single', agentName: 'agent-p' } as WorkflowNode,
    { id: Q, kind: 'agent-single', agentName: 'agent-q' } as WorkflowNode,
    { id: D, kind: 'agent-single', agentName: 'agent-d' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
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
    repoPath: '/tmp/aw-rfc128-p5-d',
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
  over: { status?: string; iteration?: number; rerunCause?: string } = {},
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
  return id
}

/** Seed a SEALABLE self round (awaiting_human, no answers yet) + the asking P run (the dispatch
 *  inherit target) + the clarify node_run. Mirrors the runner's createClarifySession. */
async function seedSealableSelfRound(
  db: DbClient,
  taskId: string,
  questions: ClarifyQuestion[],
): Promise<{ clarifyNodeRunId: string; askingRunId: string }> {
  const askingRunId = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
  const { clarifyNodeRunId } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: P,
    sourceAgentNodeRunId: askingRunId,
    sourceShardKey: null,
    clarifyNodeId: CL,
    iterationIndex: 0,
    questions,
  })
  return { clarifyNodeRunId, askingRunId }
}

/** Seed a SEALABLE cross round (awaiting_human, no answers) + the questioner Q run + the cross
 *  node_run + the dual-written legacy cross_clarify_session. */
async function seedSealableCrossRound(
  db: DbClient,
  taskId: string,
  questions: ClarifyQuestion[],
): Promise<{ crossNodeRunId: string; questionerRunId: string; roundId: string }> {
  const questionerRunId = await seedRun(db, taskId, Q, { status: 'awaiting_human', iteration: 0 })
  const crossNodeRunId = await seedRun(db, taskId, CC, { status: 'awaiting_human' })
  const roundId = ulid()
  const common = {
    id: roundId,
    taskId,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify(questions),
    answersJson: '[]',
    directive: 'continue' as const,
    status: 'awaiting_human' as const,
  }
  await db.insert(clarifyRounds).values({
    ...common,
    kind: 'cross',
    askingNodeId: Q,
    askingNodeRunId: questionerRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: crossNodeRunId,
    targetConsumerNodeId: D,
  })
  await db.insert(crossClarifySessions).values({
    ...common,
    crossClarifyNodeId: CC,
    crossClarifyNodeRunId: crossNodeRunId,
    sourceQuestionerNodeId: Q,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: D,
  })
  return { crossNodeRunId, questionerRunId, roundId }
}

function runRow(db: DbClient, id: string) {
  return db.select().from(nodeRuns).where(eq(nodeRuns.id, id))
}
function entryRow(db: DbClient, id: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id))
}

/** Insert a raw task_question entry (for the same-home park unit test). */
async function insertEntry(
  db: DbClient,
  taskId: string,
  e: {
    originNodeRunId: string
    questionId: string
    roleKind: 'self' | 'questioner' | 'designer'
    sourceKind?: 'self' | 'cross' | 'manual'
    defaultTargetNodeId: string | null
    sealed?: boolean
    dispatchedAt?: number | null
    triggerRunId?: string | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: e.questionId,
    sourceKind: e.sourceKind ?? (e.roleKind === 'self' ? 'self' : 'cross'),
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    sealedAt: e.sealed ? Date.now() : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    triggerRunId: e.triggerRunId ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}
function roundByOrigin(db: DbClient, originNodeRunId: string) {
  return db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, originNodeRunId))
}
function entriesByOrigin(db: DbClient, originNodeRunId: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.originNodeRunId, originNodeRunId))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ===========================================================================
// 快通道 seal → 自动续跑（autodispatch）
// ===========================================================================
describe('RFC-128 P5-D — quick-channel seal + autodispatch (fast-path → auto continuation)', () => {
  test('SELF round on deferred task → seals + auto-dispatches the self entry → clarify-answer rerun (pending) on P', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])

    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })

    // Round sealed (answered) + the clarify node closed.
    expect(res.roundFullySealed).toBe(true)
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
    expect((await runRow(db, clarifyNodeRunId))[0]?.status).toBe('done')

    // The self entry was reconciled, sealed, and DISPATCHED (not left staged).
    const entries = await entriesByOrigin(db, clarifyNodeRunId)
    const selfEntry = entries.find((e) => e.roleKind === 'self')
    expect(selfEntry).toBeDefined()
    expect(selfEntry?.sealedAt).not.toBeNull()
    expect(selfEntry?.dispatchedAt).not.toBeNull()

    // A clarify-answer rerun was minted on P (the golden-lock immediate-path cause).
    expect(res.dispatch.reruns).toHaveLength(1)
    const rerun = (await runRow(db, res.dispatch.reruns[0]!.nodeRunId))[0]
    expect(rerun?.nodeId).toBe(P)
    expect(rerun?.status).toBe('pending')
    expect(rerun?.rerunCause).toBe('clarify-answer')
  })

  test('CROSS all-questioner-scope round → auto-dispatches the questioner entries → cross-clarify-questioner-rerun on Q (no designer entry)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { crossNodeRunId } = await seedSealableCrossRound(db, taskId, [mkQ('q1', 't')])

    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1')],
      scopes: { q1: 'questioner' },
      actor,
    })

    expect(res.roundFullySealed).toBe(true)
    const entries = await entriesByOrigin(db, crossNodeRunId)
    // questioner-scope → NO designer entry (golden-lock cascade case).
    expect(entries.some((e) => e.roleKind === 'designer')).toBe(false)
    const qEntry = entries.find((e) => e.roleKind === 'questioner')
    expect(qEntry?.dispatchedAt).not.toBeNull()

    expect(res.dispatch.reruns).toHaveLength(1)
    const rerun = (await runRow(db, res.dispatch.reruns[0]!.nodeRunId))[0]
    expect(rerun?.nodeId).toBe(Q)
    expect(rerun?.rerunCause).toBe('cross-clarify-questioner-rerun')
  })

  test('CROSS stop round → questioner stop rerun via dispatch + canvas directive persisted (RFC-123)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { crossNodeRunId } = await seedSealableCrossRound(db, taskId, [mkQ('q1', 't')])

    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1')],
      directive: 'stop',
      actor,
    })

    // stop → no designer entries (reconcileDesiredEntries skips them); questioner reruns.
    const entries = await entriesByOrigin(db, crossNodeRunId)
    expect(entries.some((e) => e.roleKind === 'designer')).toBe(false)
    expect(res.dispatch.reruns).toHaveLength(1)
    expect((await runRow(db, res.dispatch.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe(
      'cross-clarify-questioner-rerun',
    )
    // The canvas STOP directive is written for the questioner node (sealRoundQuestions post-tx).
    const dir = await getNodeClarifyDirectiveRow(db, taskId, Q)
    expect(dir?.directive).toBe('stop')
  })
})

// ===========================================================================
// 黄金锁 — deferred 全 seal autodispatch = 旧整轮逐字（cause 对齐 + 全题注入 byte-for-byte）
// ===========================================================================
describe('RFC-128 P5-D golden-lock (deferred full-seal autodispatch == legacy whole-round)', () => {
  test('cause alignment — autodispatch SELF rerun cause == the immediate submitClarifyAnswers cause (clarify-answer)', async () => {
    // Deferred autodispatch path.
    const dbA = createInMemoryDb(MIGRATIONS)
    const taskA = `t_${ulid()}`
    await seedTask(dbA, taskA, true)
    const a = await seedSealableSelfRound(dbA, taskA, [mkQ('q1', 't')])
    const resA = await autoDispatchClarifyRound({
      db: dbA,
      originNodeRunId: a.clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    const causeA = (await runRow(dbA, resA.dispatch.reruns[0]!.nodeRunId))[0]?.rerunCause

    // Legacy immediate path (NON-deferred): submitClarifyAnswers mints the continuation directly.
    const dbB = createInMemoryDb(MIGRATIONS)
    const taskB = `t_${ulid()}`
    await seedTask(dbB, taskB, false)
    const b = await seedSealableSelfRound(dbB, taskB, [mkQ('q1', 't')])
    const resB = await submitClarifyAnswers({
      db: dbB,
      clarifyNodeRunId: b.clarifyNodeRunId,
      answers: [ans('q1')],
    })
    const causeB = (await runRow(dbB, resB.rerunNodeRunId))[0]?.rerunCause

    expect(causeA).toBe('clarify-answer')
    expect(causeA).toBe(causeB) // four-fold alignment: same cause
  })

  test('full-round injection — the auto-dispatched self rerun renders byte-for-byte == legacy whole-round buildPromptContext (no sibling block, R2-4)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [
      mkQ('q1', 'FIRST'),
      mkQ('q2', 'SECOND'),
    ])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      actor,
    })
    const rerunId = res.dispatch.reruns[0]!.nodeRunId

    // The per-question injection the scheduler will use for the auto-dispatched rerun.
    const ctx = await buildClarifyNodeQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      dispatchedRunId: rerunId,
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    // Full-round (all questions dispatched in one batch) → NO sibling/scope block (golden-lock R2-4).
    expect(ctx?.answersBlock).not.toContain('Scope of this run')
    expect(ctx?.questionsBlock).toContain('FIRST')
    expect(ctx?.questionsBlock).toContain('SECOND')

    // Reference: the legacy whole-round path on an equivalent answered round (clean DB, not dispatched).
    const refDb = createInMemoryDb(MIGRATIONS)
    await seedTask(refDb, taskId)
    const refRound = await seedSealableSelfRound(refDb, taskId, [
      mkQ('q1', 'FIRST'),
      mkQ('q2', 'SECOND'),
    ])
    await sealRoundQuestions({
      db: refDb,
      originNodeRunId: refRound.clarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      // No dispatch → the whole-round path is the renderer (not excluded by roundsWithDispatchedEntries).
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
    expect(ctx?.questionsBlock).toBe(ref?.questionsBlock)
    expect(ctx?.answersBlock).toBe(ref?.answersBlock)
  })

  test('non-deferred quick channel is UNCHANGED — autoDispatchClarifyRound REJECTS a non-deferred task (the route uses the legacy immediate mint instead)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, false) // NON-deferred
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    let caught: unknown
    try {
      await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-not-deferred-dispatch')
    // Nothing sealed / dispatched (round untouched).
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('awaiting_human')
  })

  test('optimistic lock — a STALE ifMatchIteration rejects (clarify-iteration-mismatch), nothing sealed (parity with the immediate path)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    let caught: unknown
    try {
      await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        ifMatchIteration: 99, // round.iteration is 0
        actor,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-iteration-mismatch')
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('awaiting_human') // untouched
    // The matching iteration succeeds.
    const ok = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      ifMatchIteration: 0,
      actor,
    })
    expect(ok.roundFullySealed).toBe(true)
  })

  // Codex impl-gate (high) — whole-round finalize: a PARTIAL quick submit must NOT seal+dispatch a
  // subset and leave siblings parted; it pads the unanswered questions (matching the immediate path +
  // the /clarify page) so the round is FULLY sealed and the whole round dispatches in one batch.
  test('partial defer=false answers (only q1 of q1+q2) → padded to a FULL seal, both self entries dispatched (no partial dispatch)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [
      mkQ('q1', 't'),
      mkQ('q2', 't'),
    ])
    // Only q1 supplied (a stale / malformed quick submit).
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    // The round is FULLY sealed (q2 padded blank) — never left partial + dispatched.
    expect(res.roundFullySealed).toBe(true)
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
    const selfEntries = (await entriesByOrigin(db, clarifyNodeRunId)).filter(
      (e) => e.roleKind === 'self',
    )
    expect(selfEntries).toHaveLength(2)
    expect(selfEntries.every((e) => e.sealedAt !== null && e.dispatchedAt !== null)).toBe(true)
    // One rerun (both self entries, same home P, same cause).
    expect(res.dispatch.reruns).toHaveLength(1)
  })

  // Codex impl-gate (high) — a round FULLY sealed via the CONTROL channel (staged for explicit manual
  // board dispatch) must NOT be hijacked into an auto-dispatch by a stale defer=false submit.
  test('a control-channel fully-sealed round → a stale quick submit is REJECTED (clarify-already-answered), entries NOT auto-dispatched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    // Control channel: FULLY seal the round (defer=true equivalent), leaving it staged for MANUAL
    // dispatch (no autodispatch).
    const sealed = await sealRoundQuestions({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      rejectSelfQuestionerFullSeal: true,
    })
    expect(sealed.roundFullySealed).toBe(true)
    const selfEntryBefore = (await entriesByOrigin(db, clarifyNodeRunId)).find(
      (e) => e.roleKind === 'self',
    )!
    expect(selfEntryBefore.sealedAt).not.toBeNull()
    expect(selfEntryBefore.dispatchedAt).toBeNull() // staged for manual board dispatch

    // A stale quick submit must NOT hijack it into an autodispatch.
    let caught: unknown
    try {
      await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-already-answered')
    // The control-channel entry stays UNDISPATCHED (awaiting explicit board dispatch).
    expect((await entryRow(db, selfEntryBefore.id))[0]?.dispatchedAt).toBeNull()
    expect(
      (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (r) => r.rerunCause === 'clarify-answer',
      ),
    ).toHaveLength(0)
  })
})

// ===========================================================================
// 与手动通道互不混路（per-round 单路径）+ RFC-125 单路径不变量
// ===========================================================================
describe('RFC-128 P5-D single-path (auto + manual never double-dispatch; RFC-125 invariant)', () => {
  test('an auto-dispatched round cannot be double-dispatched manually — the SAME entry, CAS no-op, exactly ONE rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    const selfEntry = (await entriesByOrigin(db, clarifyNodeRunId)).find(
      (e) => e.roleKind === 'self',
    )!
    expect(selfEntry.dispatchedAt).not.toBeNull()
    const rerunsBefore = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.rerunCause === 'clarify-answer').length
    expect(rerunsBefore).toBe(1)

    // A redundant MANUAL board dispatch of the same entry → CAS skips it (already dispatched) → no
    // second rerun. Auto + manual share the ONE dispatchTaskQuestions mechanism; per-round single path.
    const manual = await dispatchTaskQuestions(db, taskId, [selfEntry.id], actor)
    expect(manual.reruns).toHaveLength(0)
    const rerunsAfter = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.rerunCause === 'clarify-answer').length
    expect(rerunsAfter).toBe(1) // still exactly one
    void res
  })

  test('RFC-125 — autodispatch NEVER flips the task deferred flag (single path source, terminal)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, true)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.deferredQuestionDispatch).toBe(true) // unchanged
  })

  test('mixed — a control-channel partial seal (q1) then quick-channel autodispatch → seals q2, dispatches q1+q2 in ONE rerun, q1 not re-sealed / double-minted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [
      mkQ('q1', 't'),
      mkQ('q2', 't'),
    ])
    // Control channel: seal ONLY q1 (defer=true equivalent) — partial, round stays awaiting_human.
    const partial = await sealRoundQuestions({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      rejectSelfQuestionerFullSeal: true,
    })
    expect(partial.roundFullySealed).toBe(false)
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('awaiting_human')

    // Quick channel autodispatch (the whole-round answers include the already-sealed q1).
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      actor,
    })
    // q1 was filtered out of the seal (already locked); only q2 sealed this call.
    expect(res.sealedQuestionIds).toEqual(['q2'])
    expect(res.roundFullySealed).toBe(true)
    // BOTH self entries dispatched (q1+q2), one home P, one cause → exactly ONE rerun.
    const selfEntries = (await entriesByOrigin(db, clarifyNodeRunId)).filter(
      (e) => e.roleKind === 'self',
    )
    expect(selfEntries).toHaveLength(2)
    expect(selfEntries.every((e) => e.dispatchedAt !== null)).toBe(true)
    expect(res.dispatch.reruns).toHaveLength(1)
    const clarifyReruns = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.rerunCause === 'clarify-answer')
    expect(clarifyReruns).toHaveLength(1) // no double-mint
  })
})

// ===========================================================================
// designer entries 不进 autodispatch（§18 manual 留存）+ P5-0 guard 关系
// ===========================================================================
describe('RFC-128 P5-D designer-scope + P5-0 guard relationship', () => {
  test('cross designer-scope round → questioner auto-dispatched, designer entry left sealed-undispatched for §18 board dispatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { crossNodeRunId } = await seedSealableCrossRound(db, taskId, [mkQ('q1', 't')])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1')],
      scopes: { q1: 'designer' },
      actor,
    })
    const entries = await entriesByOrigin(db, crossNodeRunId)
    const qEntry = entries.find((e) => e.roleKind === 'questioner')
    const dEntry = entries.find((e) => e.roleKind === 'designer')
    // questioner auto-dispatched; designer NOT (it rides the §18 designer park + manual board dispatch).
    expect(qEntry?.dispatchedAt).not.toBeNull()
    expect(dEntry).toBeDefined()
    expect(dEntry?.sealedAt).not.toBeNull()
    expect(dEntry?.dispatchedAt).toBeNull()
    // The single auto rerun is the questioner's (designer waits for board dispatch).
    expect(res.dispatch.reruns.every((r) => r.targetNodeId === Q)).toBe(true)
  })

  // Codex re-review (high) — a stale quick submit must NOT overwrite an already-sealed (control
  // channel) question's SCOPE. sealRoundQuestions merges every provided scope key (it does not filter
  // locked questions), so autodispatch must forward scope ONLY for the not-yet-locked questions
  // (mirroring submitCrossClarifyAnswers). Otherwise: control-seal q1 designer → stale quick finalize
  // carrying q1:'questioner' would flip q1 → questioner and DELETE q1's staged designer entry.
  test('locked-scope guard — control-seal q1 as designer, then quick-finalize carrying q1:questioner → q1 stays designer, its designer entry preserved', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { crossNodeRunId } = await seedSealableCrossRound(db, taskId, [
      mkQ('q1', 't'),
      mkQ('q2', 't'),
    ])
    // Control channel: partially seal q1 as DESIGNER (round stays awaiting_human).
    const partial = await sealRoundQuestions({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1')],
      scopes: { q1: 'designer' },
      rejectSelfQuestionerFullSeal: true,
    })
    expect(partial.roundFullySealed).toBe(false)
    const q1DesignerBefore = (await entriesByOrigin(db, crossNodeRunId)).find(
      (e) => e.roleKind === 'designer' && e.questionId === 'q1',
    )
    expect(q1DesignerBefore).toBeDefined() // q1 designer entry staged

    // Stale quick finalize that tries to FLIP q1 → questioner (conflicting locked scope) + seals q2.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1'), ans('q2')],
      scopes: { q1: 'questioner', q2: 'designer' },
      actor,
    })
    // q1's stored scope is STILL designer (the locked scope was not overwritten).
    const round = (await roundByOrigin(db, crossNodeRunId))[0]
    const storedScopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(storedScopes.q1).toBe('designer')
    // q1's designer entry is PRESERVED (not deleted by a hijacked questioner re-scope) + still parked.
    const q1DesignerAfter = (await entriesByOrigin(db, crossNodeRunId)).find(
      (e) => e.roleKind === 'designer' && e.questionId === 'q1',
    )
    expect(q1DesignerAfter).toBeDefined()
    expect(q1DesignerAfter?.dispatchedAt).toBeNull()
  })

  test('P5-0 guard relationship — the guard is LIFTED on a deferred task (autodispatch full-seals a self round); it STILL fires on the NON-deferred control channel', async () => {
    // Deferred: full self seal ALLOWED (autodispatch is the release path).
    const dbDef = createInMemoryDb(MIGRATIONS)
    const taskDef = `t_${ulid()}`
    await seedTask(dbDef, taskDef, true)
    const def = await seedSealableSelfRound(dbDef, taskDef, [mkQ('q1', 't')])
    const okSeal = await sealRoundQuestions({
      db: dbDef,
      originNodeRunId: def.clarifyNodeRunId,
      answers: [ans('q1')],
      rejectSelfQuestionerFullSeal: true,
    })
    expect(okSeal.roundFullySealed).toBe(true) // guard lifted on deferred

    // Non-deferred: the control channel full self seal STILL rejects (no park source → would strand).
    const dbNon = createInMemoryDb(MIGRATIONS)
    const taskNon = `t_${ulid()}`
    await seedTask(dbNon, taskNon, false)
    const non = await seedSealableSelfRound(dbNon, taskNon, [mkQ('q1', 't')])
    let caught: unknown
    try {
      await sealRoundQuestions({
        db: dbNon,
        originNodeRunId: non.clarifyNodeRunId,
        answers: [ans('q1')],
        rejectSelfQuestionerFullSeal: true,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('clarify-selfq-full-seal-unsupported-pre-p5')
  })
})

// ===========================================================================
// 锁 B 不重入（sequential seal+dispatch, never nested）
// ===========================================================================
describe('RFC-128 P5-D lock-B non-reentry', () => {
  test('behavioral — autodispatch completes (would DEADLOCK on the non-reentrant question-write sem if seal+dispatch were nested)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    // If autoDispatchClarifyRound held lock B across the dispatch (reentry), dispatchTaskQuestions'
    // own getTaskQuestionWriteSem(taskId).run would queue forever → this await never resolves.
    const res = await Promise.race([
      autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('autodispatch deadlocked')), 5000),
      ),
    ])
    expect((res as { dispatch: { reruns: unknown[] } }).dispatch.reruns).toHaveLength(1)
    // The lock is FREE again afterward (released by both seal and dispatch).
    const sem = getTaskQuestionWriteSem(taskId)
    expect(sem.available).toBe(sem.capacity)
    expect(sem.queueLength).toBe(0)
  })

  test('source — lock order A ≻ B + no B reentry: the self rollback holds A OUTER + B INNER around the preflight+rollback, then RELEASES B before dispatchTaskQuestions re-takes a fresh B (round-10 atomicity)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '../src/services/clarifyAutoDispatch.ts'),
      'utf8',
    )
    const fn = src.slice(src.indexOf('export async function autoDispatchClarifyRound'))
    const aIdx = fn.indexOf('getTaskWriteSem(round.taskId).run') // worktree lock A OUTER
    // B is taken INNER and its .run RETURNS a `rolledBack` flag → B is RELEASED when the block returns.
    const bIdx = fn.indexOf('const rolledBack = await getTaskQuestionWriteSem(round.taskId).run')
    const preflightIdx = fn.indexOf('selfHomeHasOpenLedger(db, round.taskId') // preflight under B
    const rollbackIdx = fn.indexOf('rollbackNodeRunWorktrees(') // rollback under B
    const releaseCheckIdx = fn.indexOf('if (!rolledBack)') // checked AFTER B returned (B released)
    const dispatchCallIdx = fn.indexOf('return tryDispatch()') // dispatch's OWN B re-taken AFTER, no nest
    expect(aIdx).toBeGreaterThan(0)
    expect(bIdx).toBeGreaterThan(aIdx) // A outer, B inner (A ≻ B)
    expect(preflightIdx).toBeGreaterThan(bIdx) // preflight under B
    expect(rollbackIdx).toBeGreaterThan(preflightIdx) // rollback AFTER the preflight, under B
    expect(releaseCheckIdx).toBeGreaterThan(rollbackIdx) // B released after the rollback
    expect(dispatchCallIdx).toBeGreaterThan(releaseCheckIdx) // dispatch AFTER B released → no B-in-B
    expect(fn).toContain('sealRoundQuestions(') // seal before dispatch; takes its own B independently
  })
})

// ===========================================================================
// 源锁 — route defer=false 分支按 deferred flag 分路（autodispatch vs legacy immediate mint）
// ===========================================================================
describe('RFC-128 P5-D route defer=false routing (source lock)', () => {
  test('routes/clarify.ts defer=false branch routes a DEFERRED task to autoDispatchClarifyRound, a NON-deferred task to submitClarifyAnswers/submitCrossClarifyAnswers', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/routes/clarify.ts'), 'utf8')
    expect(src).toContain('autoDispatchClarifyRound')
    // The deferred branch is gated on the task flag and sits BEFORE the legacy immediate-mint calls.
    const autoIdx = src.indexOf('ownerTask?.deferredQuestionDispatch === true')
    const submitSelfIdx = src.indexOf('await submitClarifyAnswers({')
    const submitCrossIdx = src.indexOf('await submitCrossClarifyAnswers({')
    expect(autoIdx).toBeGreaterThan(0)
    expect(submitSelfIdx).toBeGreaterThan(autoIdx) // immediate mint is the non-deferred fallthrough
    expect(submitCrossIdx).toBeGreaterThan(autoIdx)
  })
})

// ===========================================================================
// 同 home 死锁修复（Codex round-3）— all-role deferred park（loadUndispatchedParkTargets）
// ===========================================================================
describe('RFC-128 P5-D all-role deferred park (same-home deadlock fix)', () => {
  test('a home with an UNDISPATCHED designer entry + an IN-FLIGHT self entry is NOT parked (the in-flight rerun must run); the per-role union WOULD have parked it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // Node D is BOTH a designer home (undispatched manual designer entry) AND a self home with an
    // IN-FLIGHT (dispatched, unconsumed) self entry — the §5.2.13 same-home coincidence.
    const origin = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'dq',
      roleKind: 'designer',
      sourceKind: 'manual',
      defaultTargetNodeId: D,
      // undispatched (dispatched_at NULL)
    })
    const selfOrigin = await seedRun(db, taskId, CL, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: selfOrigin,
      questionId: 'sq',
      roleKind: 'self',
      defaultTargetNodeId: D, // same home D
      sealed: true,
      dispatchedAt: Date.now(), // in-flight (dispatched, trigger NULL = queued/unconsumed)
      triggerRunId: null,
    })

    // The per-role sources, in isolation: the DESIGNER source parks D (blind to the in-flight self),
    // the SELF/Q source does NOT park D (it sees the in-flight self). Their UNION = {D} → the old
    // deadlock (D parked → the in-flight self rerun stalls; the in-flight gate blocks the designer
    // dispatch).
    const designerParked = await loadUndispatchedDesignerTargets(db, taskId)
    const selfQParked = await loadUndispatchedSelfQuestionerTargets(db, taskId)
    expect(designerParked.has(D)).toBe(true) // per-role designer source still parks (unchanged)
    expect(selfQParked.has(D)).toBe(false) // self/q source releases an in-flight home (unchanged)

    // The ALL-ROLE park (what the scheduler now uses) classifies both roles TOGETHER → D has an
    // in-flight entry → NOT parked → the pending self rerun can run (deadlock broken).
    const allRoleParked = await loadUndispatchedParkTargets(db, taskId)
    expect(allRoleParked.has(D)).toBe(false)
  })

  test('all-role park is byte-identical to the union for a non-same-home case (undispatched designer alone → parked)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'dq',
      roleKind: 'designer',
      sourceKind: 'manual',
      defaultTargetNodeId: D, // undispatched designer, no in-flight on D
    })
    const designerParked = await loadUndispatchedDesignerTargets(db, taskId)
    const allRoleParked = await loadUndispatchedParkTargets(db, taskId)
    expect(designerParked.has(D)).toBe(true)
    expect(allRoleParked.has(D)).toBe(true) // same as the union (no same-home in-flight)
  })

  test('source — scheduler uses loadUndispatchedParkTargets (all-role), not the per-role union', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/scheduler.ts'), 'utf8')
    expect(src).toContain('loadUndispatchedParkTargets(db, taskId)')
  })
})

// ===========================================================================
// RFC-098 B1 自清-isolated 回滚（Codex round-4）— self 快通道 autodispatch 回滚 worktree
// ===========================================================================
describe('RFC-128 P5-D self-clarify isolated rollback (RFC-098 B1, Codex round-4)', () => {
  test('self isolated autodispatch rolls the worktree back to the asking run pre_snapshot BEFORE dispatch; the continuation starts from the clean tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aw-rfc128-p5d-rollback-'))
    try {
      await runGit(repo, ['init', '-q', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 't@e.com'])
      await runGit(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'data.txt'), 'HEAD\n')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-q', '-m', 'init'])
      // Ask-time worktree state (a non-HEAD working change so the stash snapshot is NON-empty —
      // an empty snapshot would be a resume-mode no-op). This is the pre_snapshot the rerun restores.
      writeFileSync(join(repo, 'data.txt'), 'ASK-TIME\n')
      const snap = await gitStashSnapshot(repo)

      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      await db.update(tasks).set({ worktreePath: repo }).where(eq(tasks.id, taskId))
      const { clarifyNodeRunId, askingRunId } = await seedSealableSelfRound(db, taskId, [
        mkQ('q1', 't'),
      ])
      await db.update(nodeRuns).set({ preSnapshot: snap }).where(eq(nodeRuns.id, askingRunId))

      // Dirty the worktree AFTER the snapshot (edits the isolated rerun must NOT inherit).
      writeFileSync(join(repo, 'data.txt'), 'DIRTY\n')
      writeFileSync(join(repo, 'stray.txt'), 'stray\n')

      const res = await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })

      // The worktree was rolled back to the ask-time pre_snapshot (RFC-098 B1, like
      // submitClarifyAnswers): the post-snapshot dirty edits + strays are gone.
      expect(readFileSync(join(repo, 'data.txt'), 'utf8')).toBe('ASK-TIME\n')
      expect(existsSync(join(repo, 'stray.txt'))).toBe(false)
      // And the self continuation was still dispatched (clarify-answer).
      expect(res.dispatch.reruns).toHaveLength(1)
      expect((await runRow(db, res.dispatch.reruns[0]!.nodeRunId))[0]?.rerunCause).toBe(
        'clarify-answer',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('CROSS (questioner) autodispatch does NOT roll back the worktree (mirrors submitCrossClarifyAnswers — no rollback)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aw-rfc128-p5d-noroll-'))
    try {
      await runGit(repo, ['init', '-q', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 't@e.com'])
      await runGit(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'data.txt'), 'CLEAN\n')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-q', '-m', 'init'])
      const snap = await gitStashSnapshot(repo)

      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      await db.update(tasks).set({ worktreePath: repo }).where(eq(tasks.id, taskId))
      const { crossNodeRunId, questionerRunId } = await seedSealableCrossRound(db, taskId, [
        mkQ('q1', 't'),
      ])
      await db.update(nodeRuns).set({ preSnapshot: snap }).where(eq(nodeRuns.id, questionerRunId))

      writeFileSync(join(repo, 'data.txt'), 'DIRTY\n')

      await autoDispatchClarifyRound({
        db,
        originNodeRunId: crossNodeRunId,
        answers: [ans('q1')],
        scopes: { q1: 'questioner' },
        actor,
      })
      // The worktree is UNCHANGED (cross/questioner path never rolls back).
      expect(readFileSync(join(repo, 'data.txt'), 'utf8')).toBe('DIRTY\n')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// post-seal dispatch 冲突（Codex round-5）— 答案已 seal、autodispatch 延后到手动（非失败）
// ===========================================================================
describe('RFC-128 P5-D post-seal dispatch conflict → deferred to manual (idempotent-safe)', () => {
  test('a same-home IN-FLIGHT rerun makes dispatch conflict AFTER the seal → round SEALED + auto-dispatch DEFERRED (dispatchDeferredReason), NOT a failed request', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // A prior IN-FLIGHT dispatched self entry on home P (dispatched, trigger NULL = queued/unconsumed)
    // — blocks a new same-home dispatch via assertNoInFlightDispatch.
    const priorOrigin = await seedRun(db, taskId, CL, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: priorOrigin,
      questionId: 'prior',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: Date.now(),
      triggerRunId: null,
    })
    // New self round on the SAME home P → quick autodispatch.
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    // The answer WAS sealed (round answered) — the request did NOT fail despite the dispatch conflict.
    expect(res.roundFullySealed).toBe(true)
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
    // Auto-dispatch was DEFERRED to the board (a post-seal conflict), not surfaced as an error.
    expect(res.dispatch.reruns).toHaveLength(0)
    expect(res.dispatchDeferredReason).toBe('task-question-node-dispatch-in-flight')
    // The new self entry is sealed-undispatched → parked, recoverable via the board's manual dispatch.
    const selfEntry = (await entriesByOrigin(db, clarifyNodeRunId)).find(
      (e) => e.roleKind === 'self',
    )
    expect(selfEntry?.sealedAt).not.toBeNull()
    expect(selfEntry?.dispatchedAt).toBeNull()
  })

  test('no conflict → dispatchDeferredReason is undefined (golden path)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    expect(res.dispatchDeferredReason).toBeUndefined()
    expect(res.dispatch.reruns).toHaveLength(1)
  })
})

// ===========================================================================
// Codex round-6 — answered WS broadcast 不丢 + 不可恢复 dispatch 冲突不被吞
// ===========================================================================
describe('RFC-128 P5-D answered WS broadcast (Codex round-6 finding 1)', () => {
  test('self autodispatch → broadcastSelfClarifyAnsweredForRound emits clarify.answered (other clients invalidate)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    const received: Array<{ type: string }> = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m as { type: string }))
    await broadcastSelfClarifyAnsweredForRound(
      db,
      clarifyNodeRunId,
      res.dispatch.reruns[0]?.nodeRunId ?? '',
    )
    expect(received.find((m) => m.type === 'clarify.answered')).toBeDefined()
  })

  test('cross autodispatch → broadcastCrossClarifyAnsweredForRound emits cross-clarify.answered; stop also emits rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { crossNodeRunId } = await seedSealableCrossRound(db, taskId, [mkQ('q1', 't')])
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossNodeRunId,
      answers: [ans('q1')],
      directive: 'stop',
      actor,
    })
    const received: Array<{ type: string }> = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m as { type: string }))
    await broadcastCrossClarifyAnsweredForRound(db, crossNodeRunId, {
      rejectedQuestionerNodeRunId: '',
    })
    expect(received.find((m) => m.type === 'cross-clarify.answered')).toBeDefined()
    expect(received.find((m) => m.type === 'cross-clarify.rejected')).toBeDefined()
  })

  test('broadcast helper is a NO-OP for a still-awaiting (un-answered) round', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    // NOT answered (no autodispatch / seal).
    const received: Array<{ type: string }> = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m as { type: string }))
    await broadcastSelfClarifyAnsweredForRound(db, clarifyNodeRunId, '')
    expect(received.find((m) => m.type === 'clarify.answered')).toBeUndefined()
  })

  test('source — the route autodispatch branch emits the answered broadcast for both self and cross', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/routes/clarify.ts'), 'utf8')
    expect(src).toContain('broadcastSelfClarifyAnsweredForRound(deps.db, nodeRunId')
    expect(src).toContain('broadcastCrossClarifyAnsweredForRound(deps.db, nodeRunId')
  })
})

describe('RFC-128 P5-D non-recoverable dispatch conflict NOT swallowed (Codex round-6 finding 2)', () => {
  test('a NON-recoverable dispatch conflict (unparseable snapshot) is RETHROWN, not masked as a deferred success', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { clarifyNodeRunId } = await seedSealableSelfRound(db, taskId, [mkQ('q1', 't')])
    // Corrupt the snapshot AFTER seeding (worktreePath stays '' so the rollback path is skipped and
    // only dispatchTaskQuestions' parseDefinition hits it → task-question-snapshot-unparseable).
    await db.update(tasks).set({ workflowSnapshot: 'not json{' }).where(eq(tasks.id, taskId))
    let caught: unknown
    try {
      await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-snapshot-unparseable') // rethrown, NOT swallowed
    // Codex round-7: the seal COMMITTED before the dispatch rethrew → the round IS answered, so the
    // route's error-path broadcast (emitAutoAnswered on catch) WILL fire clarify.answered (other
    // clients invalidate) before surfacing the failure. Prove the round is answered + the helper fires.
    expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
    const received: Array<{ type: string }> = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m as { type: string }))
    await broadcastSelfClarifyAnsweredForRound(db, clarifyNodeRunId, '')
    expect(received.find((m) => m.type === 'clarify.answered')).toBeDefined()
  })

  test('source — the route broadcasts the answered event on the autodispatch ERROR path too (catch → emit → rethrow), so a committed answer is never hidden behind a failed response', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/routes/clarify.ts'), 'utf8')
    // The autodispatch is wrapped in try/catch; the catch emits the answered broadcast then rethrows.
    const autoIdx = src.indexOf('auto = await autoDispatchClarifyRound({')
    const catchIdx = src.indexOf("await emitAutoAnswered('')")
    const throwIdx = src.indexOf('throw err', catchIdx)
    expect(autoIdx).toBeGreaterThan(0)
    expect(catchIdx).toBeGreaterThan(autoIdx) // emit AFTER the try
    expect(throwIdx).toBeGreaterThan(catchIdx) // rethrow AFTER the emit
  })
})

// ===========================================================================
// Codex round-8 — self isolated rollback 不在「同 home 在飞续跑」时 clobber worktree
// ===========================================================================
describe('RFC-128 P5-D self rollback pre-flight (Codex round-8 finding 1 — no clobber)', () => {
  test('a same-home IN-FLIGHT rerun → autodispatch DEFERS without rolling back the worktree (the in-flight rerun owns it)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aw-rfc128-p5d-noclobber-'))
    try {
      await runGit(repo, ['init', '-q', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 't@e.com'])
      await runGit(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'data.txt'), 'HEAD\n')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-q', '-m', 'init'])
      writeFileSync(join(repo, 'data.txt'), 'ASK-TIME\n')
      const snap = await gitStashSnapshot(repo) // non-empty pre_snapshot (would roll back if not deferred)

      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      await db.update(tasks).set({ worktreePath: repo }).where(eq(tasks.id, taskId))
      // A prior IN-FLIGHT dispatched self entry on home P (dispatched, trigger NULL = unconsumed) —
      // it OWNS the worktree; an unconditional rollback would rewrite the tree under its (pending) rerun.
      const priorOrigin = await seedRun(db, taskId, CL, { status: 'done' })
      await insertEntry(db, taskId, {
        originNodeRunId: priorOrigin,
        questionId: 'prior',
        roleKind: 'self',
        defaultTargetNodeId: P,
        sealed: true,
        dispatchedAt: Date.now(),
        triggerRunId: null,
      })
      // New self round on the SAME home P, with a pre_snapshot (would trigger the rollback path).
      const { clarifyNodeRunId, askingRunId } = await seedSealableSelfRound(db, taskId, [
        mkQ('q1', 't'),
      ])
      await db.update(nodeRuns).set({ preSnapshot: snap }).where(eq(nodeRuns.id, askingRunId))
      // Dirty the worktree — it must SURVIVE (the rollback is skipped because we defer).
      writeFileSync(join(repo, 'data.txt'), 'DIRTY\n')

      const res = await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })

      // Deferred (same-home in-flight) — NO rollback ran (the worktree is NOT clobbered).
      expect(res.dispatchDeferredReason).toBe('task-question-node-dispatch-in-flight')
      expect(res.dispatch.reruns).toHaveLength(0)
      expect(readFileSync(join(repo, 'data.txt'), 'utf8')).toBe('DIRTY\n') // worktree untouched
      // The answer is still sealed (round answered) + the new entry parked for a later board dispatch.
      expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
      const selfEntry = (await entriesByOrigin(db, clarifyNodeRunId)).find(
        (e) => e.roleKind === 'self' && e.questionId === 'q1',
      )
      expect(selfEntry?.dispatchedAt).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// Codex round-9 — self 回滚 preflight 也认「同 home 开放 immediate 续跑」（无 dispatched_at）
// ===========================================================================
describe('RFC-128 P5-D self rollback pre-flight covers the immediate ledger (Codex round-9)', () => {
  test('a same-home OPEN IMMEDIATE continuation (pending quick-channel rerun, no dispatched_at) → autodispatch DEFERS without rolling back', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aw-rfc128-p5d-imm-noclobber-'))
    try {
      await runGit(repo, ['init', '-q', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 't@e.com'])
      await runGit(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'data.txt'), 'HEAD\n')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-q', '-m', 'init'])
      writeFileSync(join(repo, 'data.txt'), 'ASK-TIME\n')
      const snap = await gitStashSnapshot(repo)

      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      await db.update(tasks).set({ worktreePath: repo }).where(eq(tasks.id, taskId))

      // A PRIOR self round on home P (answered, in clarify_rounds ONLY — no clarify_sessions row, so
      // the NEW round's createClarifySession at iterationIndex=0 still mints its own clarify node_run,
      // no reuse) + a PENDING clarify-answer continuation on P: an OPEN IMMEDIATE ledger with NO
      // dispatched_at row (the quick-channel "in flight" shape findOpenImmediateLedgerHome detects).
      const priorAsk = await seedRun(db, taskId, P, { status: 'awaiting_human', iteration: 0 })
      const priorCl = await seedRun(db, taskId, CL, { status: 'awaiting_human' })
      await db.insert(clarifyRounds).values({
        id: ulid(),
        taskId,
        kind: 'self',
        askingNodeId: P,
        askingNodeRunId: priorAsk,
        intermediaryNodeId: CL,
        intermediaryNodeRunId: priorCl,
        loopIter: 0,
        iteration: 0,
        questionsJson: JSON.stringify([mkQ('pq', 't')]),
        answersJson: JSON.stringify([ans('pq')]),
        directive: 'continue',
        status: 'answered',
        answeredAt: Date.now(),
      })
      await seedRun(db, taskId, P, {
        status: 'pending',
        rerunCause: 'clarify-answer',
        iteration: 0,
      })

      // A NEW self round on the SAME home P with a pre_snapshot (would trigger the rollback path).
      const { clarifyNodeRunId, askingRunId } = await seedSealableSelfRound(db, taskId, [
        mkQ('q1', 't'),
      ])
      await db.update(nodeRuns).set({ preSnapshot: snap }).where(eq(nodeRuns.id, askingRunId))
      // Dirty the worktree — it must SURVIVE (the immediate-ledger preflight defers before rollback).
      writeFileSync(join(repo, 'data.txt'), 'DIRTY\n')

      const res = await autoDispatchClarifyRound({
        db,
        originNodeRunId: clarifyNodeRunId,
        answers: [ans('q1')],
        actor,
      })

      expect(res.dispatchDeferredReason).toBe('task-question-node-dispatch-in-flight')
      expect(res.dispatch.reruns).toHaveLength(0)
      // The open immediate continuation owns the worktree → NOT clobbered (round-9 fix).
      expect(readFileSync(join(repo, 'data.txt'), 'utf8')).toBe('DIRTY\n')
      expect((await roundByOrigin(db, clarifyNodeRunId))[0]?.status).toBe('answered')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
