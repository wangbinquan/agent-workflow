// RFC-133 (design/RFC-133-dispatch-queued-run-obligation) — GATE integration for the queued
// 「run 义务」contract. Locks the live QMGP5 deadlock repro (task 01KWFZRQFPZFQQEM8JTCHQMGP5,
// 2026-07-02) red→green plus the guards that must NOT regress:
//
//   1. QMGP5 repro: two successive self rounds each reassign one question to a NEVER-RUN
//      downstream node → the second batch dispatch used to 409 permanently
//      (task-question-node-dispatch-in-flight — the queued round-4 entry could only be consumed
//      by a node that runs AFTER the asking node gets these very answers: circular wait). Now it
//      dispatches: frontier-only mint, queued entries stay queued for the downstream's first run.
//   2. idle target (all top-level runs done) + SAME cause → releases and mints there.
//   3. ALIEN cause queued entry on the mint target → still 409 (Codex design-gate P2 —
//      §5.2.12 one-run-one-cause serialization), details carry the node.
//   4. run obligation (pending rerun on the target) → still 409 (double-mint guard), details
//      carry the blocking run id + status.
//   5-7. quick-channel mint guards (clarify self / cross questioner) share the same oracle:
//      a queued SAME-cause entry on a no-obligation home no longer wedges the quick answer; an
//      alien-cause (designer) queued entry still blocks the mint (the unified quick channel
//      seals the answer and PARKS the dispatch — dispatchDeferredReason — instead of the
//      legacy pre-seal reject).

import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { createClarifySession } from '../src/services/clarify'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const ASKER = 'asker' // self-clarifying upstream agent (QMGP5's agent_m7p3n1)
const DOWN = 'down' // never-run downstream agent (QMGP5's agent_1k2ftd)
const CL = 'cl' // self clarify node
const CC = 'cc' // cross-clarify node (quick-path questioner tests)
const actor = { userId: 'u1', role: 'owner' as const }

/** asker --out--> down (dataflow), plus the self-clarify channel pair on ASKER and a
 *  cross-clarify channel triple on DOWN (channel edges are excluded from the frontier DAG). */
function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DOWN, kind: 'agent-single', agentName: 'agent-down' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: ASKER, portName: 'out' },
        target: { nodeId: DOWN, portName: 'in' },
      },
      {
        id: 'e_ask_cl',
        source: { nodeId: ASKER, portName: '__clarify__' },
        target: { nodeId: CL, portName: 'questions' },
      },
      {
        id: 'e_cl_ask',
        source: { nodeId: CL, portName: 'answers' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
      {
        id: 'e_down_cc',
        source: { nodeId: DOWN, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_down',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: DOWN, portName: '__clarify_response__' },
      },
      {
        id: 'e_cc_ask',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: ASKER, portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

function mkQ(id: string): ClarifyQuestion {
  return {
    id,
    title: id,
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

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc133',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc133',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc133',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { status?: string; hasOutput?: boolean; rerunCause?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  dispatchedAt?: number | null
  triggerRunId?: string | null
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
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: Date.now(),
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

const entryRow = (db: DbClient, id: string) =>
  db.select().from(taskQuestions).where(eq(taskQuestions.id, id))
const taskRuns = (db: DbClient, taskId: string) =>
  db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))

beforeEach(() => resetBroadcastersForTests())

describe('RFC-133 dispatch gate — queued entries stop wedging never-run / idle targets', () => {
  test('QMGP5 repro (red→green): second batch with a reassigned entry to a NEVER-RUN downstream dispatches', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // QMGP5 state: the asker finished each round done-NO-output (it only asked follow-ups);
    // DOWN never ran at all.
    await seedRun(db, taskId, ASKER, { status: 'done' })
    const round4Origin = await seedRun(db, taskId, CL, { status: 'done' })
    const round5Origin = await seedRun(db, taskId, CL, { status: 'done' })
    // Round-4 analog: grid-spec — dispatched, reassigned to DOWN, forever queued (trigger NULL).
    const gridSpec = await insertEntry(db, taskId, {
      originNodeRunId: round4Origin,
      questionId: 'grid-spec',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
      dispatchedAt: Date.now() - 1000,
    })
    // Round-5 analog: powerup (reassigned to DOWN too) + one native asker question, both staged.
    const powerup = await insertEntry(db, taskId, {
      originNodeRunId: round5Origin,
      questionId: 'powerup',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
      stagedAt: Date.now(),
    })
    const native = await insertEntry(db, taskId, {
      originNodeRunId: round5Origin,
      questionId: 'native',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      stagedAt: Date.now(),
    })

    const result = await dispatchTaskQuestions(db, taskId, [powerup, native], actor)

    // Frontier-only mint: ONE clarify-answer rerun on ASKER, NOTHING on DOWN.
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]!.targetNodeId).toBe(ASKER)
    expect(result.dispatchedEntryIds.sort()).toEqual([powerup, native].sort())
    const runs = await taskRuns(db, taskId)
    expect(runs.filter((r) => r.nodeId === DOWN).length).toBe(0)
    const minted = runs.find((r) => r.id === result.reruns[0]!.nodeRunId)
    expect(minted?.nodeId).toBe(ASKER)
    expect(minted?.rerunCause).toBe('clarify-answer')
    // Both DOWN-bound entries stay QUEUED (trigger NULL) — DOWN's first natural run binds them.
    expect((await entryRow(db, gridSpec))[0]!.triggerRunId).toBeNull()
    const powerupRow = (await entryRow(db, powerup))[0]!
    expect(powerupRow.dispatchedAt).not.toBeNull()
    expect(powerupRow.triggerRunId).toBeNull()
  })

  test('idle target (all runs done) + SAME cause: a later dispatch to it releases and mints', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { status: 'done', hasOutput: true })
    const origin = await seedRun(db, taskId, CL, { status: 'done' })
    // A previously dispatched entry on ASKER that never got bound (queued) — e.g. its dispatch
    // crashed before the rerun spawned and the rerun was later GC'd... state: dispatched+NULL.
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'old-queued',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 1000,
    })
    const fresh = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'fresh',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      stagedAt: Date.now(),
    })
    const result = await dispatchTaskQuestions(db, taskId, [fresh], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]!.targetNodeId).toBe(ASKER)
    expect((await entryRow(db, fresh))[0]!.dispatchedAt).not.toBeNull()
  })

  test('ALIEN-cause queued entry on the mint target still 409s (Codex P2), details carry the node, nothing stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { status: 'done', hasOutput: true })
    const origin = await seedRun(db, taskId, CC, { status: 'done' })
    // A queued DESIGNER (cross-clarify-answer) entry on ASKER…
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'designer-queued',
      roleKind: 'designer',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 1000,
    })
    // …must block a SELF (clarify-answer) mint on ASKER even though ASKER has no open run.
    const selfOrigin = await seedRun(db, taskId, CL, { status: 'done' })
    const selfEntry = await insertEntry(db, taskId, {
      originNodeRunId: selfOrigin,
      questionId: 'self-fresh',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      stagedAt: Date.now(),
    })
    const runsBefore = (await taskRuns(db, taskId)).length
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [selfEntry], actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    const err = caught as ConflictError
    expect(err.code).toBe('task-question-node-dispatch-in-flight')
    expect((err.details as { nodeId?: string }).nodeId).toBe(ASKER)
    // Pure cause-serialization block: no open run to point at.
    expect((err.details as { runId?: string }).runId).toBeUndefined()
    // Fail-fast: nothing stamped, nothing minted.
    expect((await entryRow(db, selfEntry))[0]!.dispatchedAt).toBeNull()
    expect((await taskRuns(db, taskId)).length).toBe(runsBefore)
  })

  test('run obligation (pending rerun on the target) still 409s, details carry the blocking run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { status: 'done' })
    const pendingRun = await seedRun(db, taskId, ASKER, {
      status: 'pending',
      rerunCause: 'clarify-answer',
    })
    const origin = await seedRun(db, taskId, CL, { status: 'done' })
    // The pending rerun belongs to this already-dispatched (still unbound) entry.
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'in-flight',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 1000,
    })
    const nextEntry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'next',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      stagedAt: Date.now(),
    })
    let caught: unknown
    try {
      await dispatchTaskQuestions(db, taskId, [nextEntry], actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    const err = caught as ConflictError
    expect(err.code).toBe('task-question-node-dispatch-in-flight')
    const details = err.details as { nodeId?: string; runId?: string; runStatus?: string }
    expect(details.nodeId).toBe(ASKER)
    expect(details.runId).toBe(pendingRun)
    expect(details.runStatus).toBe('pending')
  })
})

describe('RFC-133 quick-channel mint guards — same-cause queued entry no longer wedges the submit', () => {
  test('clarify self quick-finalize: queued SAME-cause entry on a no-obligation home → submit succeeds and mints', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // QMGP5-style: the asking run is DONE (it finished by asking); no other ASKER runs.
    const askRun = await seedRun(db, taskId, ASKER, { status: 'done' })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: ASKER,
      sourceAgentNodeRunId: askRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1')],
    })
    // Another round's SELF entry on home ASKER: dispatched but never bound (queued).
    const otherOrigin = await seedRun(db, taskId, CL, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: otherOrigin,
      questionId: 'queued-self',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 1000,
    })
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    expect(ret).toBeDefined()
    // The clarify-answer continuation WAS minted on the home (not parked).
    expect(ret.dispatchDeferredReason).toBeUndefined()
    const conts = (await taskRuns(db, taskId)).filter(
      (r) => r.nodeId === ASKER && r.rerunCause === 'clarify-answer',
    )
    expect(conts.length).toBe(1)
  })

  test('clarify self quick-finalize: queued ALIEN-cause (designer) entry on the home still blocks the mint (parked, no rerun)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const askRun = await seedRun(db, taskId, ASKER, { status: 'done' })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: ASKER,
      sourceAgentNodeRunId: askRun,
      sourceShardKey: null,
      clarifyNodeId: CL,
      iterationIndex: 0,
      questions: [mkQ('q1')],
    })
    const ccOrigin = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: ccOrigin,
      questionId: 'queued-designer',
      roleKind: 'designer',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 1000,
    })
    const runsBefore = (await taskRuns(db, taskId)).length
    // RFC-132 unified quick channel: the alien-cause gate fires AFTER the seal committed, so the
    // answer is saved + the dispatch PARKS (dispatchDeferredReason) instead of the legacy pre-seal
    // ConflictError — the mint is still blocked: no rerun, no new node_run.
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [ans('q1')],
      actor,
    })
    expect(ret.dispatchDeferredReason).toBe('task-question-node-dispatch-in-flight')
    expect(ret.dispatch.reruns).toHaveLength(0)
    expect((await taskRuns(db, taskId)).length).toBe(runsBefore)
  })

  test('cross questioner submit: queued SAME-cause questioner entry on the questioner home → cascade rerun mints', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // designer (feedback consumer) has a prior done draft; questioner home DOWN asked and is done.
    await seedRun(db, taskId, ASKER, { status: 'done', hasOutput: true })
    const qRun = await seedRun(db, taskId, DOWN, { status: 'done' })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: CC,
      sourceQuestionerNodeId: DOWN,
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: ASKER,
      loopIter: 0,
      questions: [mkQ('q1')],
    })
    // Another round's QUESTIONER entry on home DOWN: dispatched, queued.
    const otherOrigin = await seedRun(db, taskId, CC, { status: 'done' })
    await insertEntry(db, taskId, {
      originNodeRunId: otherOrigin,
      questionId: 'queued-questioner',
      roleKind: 'questioner',
      defaultTargetNodeId: DOWN,
      dispatchedAt: Date.now() - 1000,
    })
    // questioner-scoped answer + continue → mints the questioner cascade rerun on DOWN.
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      scopes: { q1: 'questioner' },
      actor,
    })
    expect(ret).toBeDefined()
    const qReruns = (await taskRuns(db, taskId)).filter(
      (r) => r.nodeId === DOWN && r.rerunCause === 'cross-clarify-questioner-rerun',
    )
    expect(qReruns.length).toBe(1)
  })
})

// Source-level guard (test-with-every-change 兜底): the two dispatch gates must keep passing the
// batch's mint causes into the shared oracle — silently dropping the argument would resurrect the
// alien-cause collapse without failing any type check (the param is optional on the oracle).
test('source lock: taskQuestionDispatch threads mintCauseByTarget into BOTH gate call sites', async () => {
  const src = await Bun.file(
    fileURLToPath(new URL('../src/services/taskQuestionDispatch.ts', import.meta.url)),
  ).text()
  const matches = src.match(/mintCauseByTarget/g) ?? []
  expect(matches.length).toBeGreaterThanOrEqual(4) // decl + assertNoInFlightDispatch + in-tx recheck + param
})
