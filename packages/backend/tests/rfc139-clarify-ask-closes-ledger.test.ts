// RFC-139 (design/RFC-139-clarify-ask-closes-ledger) — 反问收场的承接 run 关闭改派台账。
//
// Live failure (2026-07-03, task 01KWFZRQFPZFQQEM8JTCHQMGP5 "QMGP5" — the SAME task RFC-133's
// live-deadlock fix was minted from; second ledger incident on one task):
//   pre-bind (2a): the cross-designer revision rerun ended in a NEW self clarify round (done, NO
//     output — runner keeps clarify-ask runs status=done with no port, PERMANENTLY). The in-flight
//     gate (RFC-133) correctly released the next round's dispatch, but resolveBorrowForNode's
//     'revivable' oracle demanded done+output → the designer ledger stayed open FOREVER → with the
//     freshly dispatched self ledger (queued=open) that's 2 open ledgers →
//     task-question-borrow-ledger-conflict → node failed → task failed. Deterministic, not a race.
//   post-bind (2b, Codex design-gate P1): once the released rerun starts, buildClarifyQueueContext
//     → bindTriggerRun REBINDS BOTH ledgers' entries to itself. If that run then fails / is
//     interrupted, both ledgers point at ONE handler chain — a single rerun's revival, NOT
//     duplicate execution — yet the old count-only reject killed every revival attempt.
//
// Fix under test:
//   ① bound branch: done (regardless of output) = consumed in BOTH modes (the 'revivable'
//     done-no-output→open semantics was the RFC-127 borrow-the-same-handler relic; after RFC-131
//     T4 de-borrow + RFC-132 ③ its only consumer is the reject count — pure false positive).
//   ② anchor coalescing: reject only when the open ledgers' anchor sets (trigger_run_id of open
//     BOUND entries; queued entries mint no anchor) are DISJOINT. Intersecting anchors = one
//     shared handler chain = one pending rerun serving both ledgers → no duplicate execution.
// Preserved verbatim: queued → open (unconditional, 'revivable'); failed/interrupted/pending/
// running handler → open (revival still owed); dual-queued reject (rfc128-p5-bc three cases).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
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
import { resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import { isDispatchedEntryConsumed } from '../src/services/clarifyRerunLedger'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { RunLineageView, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type {
  nodeRuns as nodeRunsTable,
  taskQuestions as taskQuestionsTable,
} from '../src/db/schema'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const D = 'D' // the designer / home node both ledgers land on (QMGP5's agent_m7p3n1)
const Q = 'Q' // cross questioner
const CL = 'CL'
const CC = 'CC'

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: D, kind: 'agent-single', agentName: 'agent-d' } as WorkflowNode,
    { id: Q, kind: 'agent-single', agentName: 'agent-q' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return { $schema_version: 4, inputs: [], nodes, edges: [], outputs: [] }
}

async function seedTask(db: DbClient, taskId: string): Promise<void> {
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
    repoPath: '/tmp/aw-rfc139',
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

/** A self clarify round whose ASKING run is an EXISTING run (the true QMGP5 shape: the round-N+1
 *  questions were asked BY the ledger's own handler run — seedAnsweredRound-style helpers mint a
 *  fresh asking run, which would pollute the handler lineage window on the same node). */
async function seedSelfRoundAskedBy(
  db: DbClient,
  taskId: string,
  askingRunId: string,
): Promise<{ intermediaryNodeRunId: string }> {
  const intRunId = await seedRun(db, taskId, CL, { status: 'awaiting_human' })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: D,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([]),
    answersJson: JSON.stringify([]),
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  return { intermediaryNodeRunId: intRunId }
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  triggerRunId?: string | null
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
    loopIter: 0,
    defaultTargetNodeId: D,
    overrideTargetNodeId: null,
    sealedAt: Date.now(),
    dispatchedAt: Date.now(),
    dispatchedBy: 'u1',
    triggerRunId: e.triggerRunId ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ===========================================================================
// ① pure oracle matrix — isDispatchedEntryConsumed, bound branch
// ===========================================================================

type NodeRunRow = typeof nodeRunsTable.$inferSelect
type TaskQuestionRow = typeof taskQuestionsTable.$inferSelect
type EntryPick = Pick<
  TaskQuestionRow,
  'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind' | 'sourceKind'
>

const TARGET = 'agent_target'

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: TARGET,
    iteration: 0,
    parentNodeRunId: null,
    rerunCause: null,
    status: 'done',
    ...over,
  } as NodeRunRow
}

function mkLineage(over: Partial<RunLineageView>): RunLineageView {
  return {
    id: 'h1',
    nodeId: TARGET,
    iteration: 0,
    loopIter: 0,
    rerunCause: 'clarify-answer',
    status: 'done',
    hasOutput: false,
    startedAt: 1,
    parentNodeRunId: null,
    shardKey: null, // RFC-172b T1
    ...over,
  }
}

const BOUND: EntryPick = {
  triggerRunId: 'h1',
  defaultTargetNodeId: TARGET,
  overrideTargetNodeId: null,
  roleKind: 'designer',
  sourceKind: 'cross',
}
const QUEUED: EntryPick = { ...BOUND, triggerRunId: null }
const H1_RUNS = [mkRun({ id: 'h1', rerunCause: 'cross-clarify-answer' })]

describe('RFC-139 ① — bound done (regardless of output) = consumed in BOTH modes', () => {
  test('revivable + done-no-output → consumed (the QMGP5 fix; was open forever)', () => {
    const doneNoOut = [mkLineage({ id: 'h1', hasOutput: false })]
    expect(isDispatchedEntryConsumed(BOUND, H1_RUNS, doneNoOut, 'revivable')).toBe(true)
    expect(isDispatchedEntryConsumed(BOUND, H1_RUNS, doneNoOut, 'in-flight')).toBe(true)
  })

  test('revivable + done+output → consumed (unchanged)', () => {
    const doneOut = [mkLineage({ id: 'h1', hasOutput: true })]
    expect(isDispatchedEntryConsumed(BOUND, H1_RUNS, doneOut, 'revivable')).toBe(true)
  })

  test('revivable + failed / interrupted / canceled / pending / running handler → still open (revival owed)', () => {
    for (const status of ['failed', 'interrupted', 'canceled', 'pending', 'running'] as const) {
      const lineage = [mkLineage({ id: 'h1', status })]
      const runs = [mkRun({ id: 'h1', rerunCause: 'cross-clarify-answer', status })]
      expect(isDispatchedEntryConsumed(BOUND, runs, lineage, 'revivable')).toBe(false)
      expect(isDispatchedEntryConsumed(BOUND, runs, lineage, 'in-flight')).toBe(false)
    }
  })

  test('revivable + queued → open unconditionally (unchanged — the ledger of its own pending rerun)', () => {
    expect(isDispatchedEntryConsumed(QUEUED, [], [], 'revivable')).toBe(false)
  })
})

// ===========================================================================
// ② resolveBorrowForNode — QMGP5 shapes + anchor coalescing + preserved rejects
// ===========================================================================

describe('RFC-139 ② — resolveBorrowForNode ledger conflict scope', () => {
  test('pre-bind (QMGP5 main shape): designer bound→done-no-output + self queued + pending rerun → no conflict', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // retry-11 analogue: the designer revision rerun, done with NO output (it asked round 9).
    const crossAnswerRun = await seedRun(db, taskId, D, {
      status: 'done',
      rerunCause: 'cross-clarify-answer',
    })
    const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccRun,
      questionId: 'dq1',
      roleKind: 'designer',
      triggerRunId: crossAnswerRun,
    })
    // round 9, asked BY retry 11; its 5 entries freshly dispatched (queued — trigger NULL).
    const round9 = await seedSelfRoundAskedBy(db, taskId, crossAnswerRun)
    await insertEntry(db, taskId, {
      originNodeRunId: round9.intermediaryNodeRunId,
      questionId: 'sq1',
      roleKind: 'self',
      triggerRunId: null,
    })
    // retry-12 analogue: the freshly minted clarify-answer rerun (upper bound of the designer
    // entry's lineage window — the designer ledger resolves to retry 11, not to this).
    await seedRun(db, taskId, D, { status: 'pending', rerunCause: 'clarify-answer' })

    expect(await resolveBorrowForNode(db, taskId, D, 0, liveDef())).toBeNull()
  })

  test('post-bind (Codex design-gate P1): both ledgers rebound to ONE failed run + revival pending → coalesced, no conflict', async () => {
    for (const crashedStatus of ['failed', 'interrupted'] as const) {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      // retry 11: asked round 9 (kept for the round's asking-run iteration match).
      const askedBy = await seedRun(db, taskId, D, {
        status: 'done',
        rerunCause: 'cross-clarify-answer',
      })
      // retry 12: the released rerun — bindTriggerRun rebound BOTH ledgers to it — then crashed.
      const crashed = await seedRun(db, taskId, D, {
        status: crashedStatus,
        rerunCause: 'clarify-answer',
      })
      const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
      await insertEntry(db, taskId, {
        originNodeRunId: ccRun,
        questionId: 'dq1',
        roleKind: 'designer',
        triggerRunId: crashed,
      })
      const round9 = await seedSelfRoundAskedBy(db, taskId, askedBy)
      await insertEntry(db, taskId, {
        originNodeRunId: round9.intermediaryNodeRunId,
        questionId: 'sq1',
        roleKind: 'self',
        triggerRunId: crashed,
      })
      // retry 13: the revival (non-clarify cause — falls INSIDE both windows).
      await seedRun(db, taskId, D, { status: 'pending', rerunCause: 'revival' })

      expect(await resolveBorrowForNode(db, taskId, D, 0, liveDef())).toBeNull()
    }
  })

  test('symmetric pre-bind: self ledger bound→done-no-output + designer queued → no conflict', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const askedBy = await seedRun(db, taskId, D, { status: 'done' })
    const round = await seedSelfRoundAskedBy(db, taskId, askedBy)
    // the self continuation ran and ended in ANOTHER ask (done, no output).
    const selfContinuation = await seedRun(db, taskId, D, {
      status: 'done',
      rerunCause: 'clarify-answer',
    })
    await insertEntry(db, taskId, {
      originNodeRunId: round.intermediaryNodeRunId,
      questionId: 'sq1',
      roleKind: 'self',
      triggerRunId: selfContinuation,
    })
    const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccRun,
      questionId: 'dq1',
      roleKind: 'designer',
      triggerRunId: null,
    })
    await seedRun(db, taskId, D, { status: 'pending', rerunCause: 'cross-clarify-answer' })

    expect(await resolveBorrowForNode(db, taskId, D, 0, liveDef())).toBeNull()
  })

  test('true conflict preserved: dual-queued (∅ vs ∅ anchors) → still rejects', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const askedBy = await seedRun(db, taskId, D, { status: 'done' })
    const round = await seedSelfRoundAskedBy(db, taskId, askedBy)
    await insertEntry(db, taskId, {
      originNodeRunId: round.intermediaryNodeRunId,
      questionId: 'sq1',
      roleKind: 'self',
      triggerRunId: null,
    })
    const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccRun,
      questionId: 'dq1',
      roleKind: 'designer',
      triggerRunId: null,
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

  test('true conflict preserved: disjoint bound anchors ({X} vs {Y}, both un-done) → still rejects', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const askedBy = await seedRun(db, taskId, D, { status: 'done' })
    const f1 = await seedRun(db, taskId, D, {
      status: 'failed',
      rerunCause: 'cross-clarify-answer',
    })
    const f2 = await seedRun(db, taskId, D, { status: 'failed', rerunCause: 'clarify-answer' })
    const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccRun,
      questionId: 'dq1',
      roleKind: 'designer',
      triggerRunId: f1,
    })
    const round = await seedSelfRoundAskedBy(db, taskId, askedBy)
    await insertEntry(db, taskId, {
      originNodeRunId: round.intermediaryNodeRunId,
      questionId: 'sq1',
      roleKind: 'self',
      triggerRunId: f2,
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

  test('mixed ride: designer bound {X} + self bound {X}+queued sibling → anchors intersect, no conflict', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const askedBy = await seedRun(db, taskId, D, { status: 'done' })
    const crashed = await seedRun(db, taskId, D, {
      status: 'failed',
      rerunCause: 'clarify-answer',
    })
    const ccRun = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccRun,
      questionId: 'dq1',
      roleKind: 'designer',
      triggerRunId: crashed,
    })
    const round = await seedSelfRoundAskedBy(db, taskId, askedBy)
    await insertEntry(db, taskId, {
      originNodeRunId: round.intermediaryNodeRunId,
      questionId: 'sq1',
      roleKind: 'self',
      triggerRunId: crashed,
    })
    // a later same-cause sibling still queued — rides the same chain (RFC-133 case 7 semantics).
    await insertEntry(db, taskId, {
      originNodeRunId: round.intermediaryNodeRunId,
      questionId: 'sq2',
      roleKind: 'self',
      triggerRunId: null,
    })
    await seedRun(db, taskId, D, { status: 'pending', rerunCause: 'revival' })

    expect(await resolveBorrowForNode(db, taskId, D, 0, liveDef())).toBeNull()
  })
})
