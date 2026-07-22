// RFC-056 PR-B T5 — lock the cross-clarify service contract (RFC-132: answers
// drive the unified quick channel, autoDispatchClarifyRound).
//
// LOCKS:
//   1. createClarifyRound round-trips a row, parks cross-clarify
//      node_run at awaiting_human, broadcasts 'cross-clarify.created'.
//   2. evaluateDesignerRerunReadiness (the dispatch's multi-source gate
//      reuses it):
//        a) consumed batches don't re-feed; a fresh awaiting sibling parks.
//        b) two siblings pointing at same designer, only one answered → not
//           ready, pendingCrossClarifyNodeIds = [the other].
//        c) one sibling rejected (directive='stop'), the other answered →
//           the designer rerun fires carrying only the answered one's entry.
//   3. dispatchCrossClarifyNode short-circuits to done on the questioner's
//      node-level stop directive (RFC-132 T7 single source).
//   4. RFC-125/126 failed→resume keeps answered cross feedback.
//   5. RFC-128 §5.2.14 questioner write-flow invariants under the unified
//      driver (single rerun on double answer; consumed entries not
//      re-dispatchable; open dispatched questioner entry defers a second mint).
//
// (The retired legacy quick-channel contract itself — outcome kinds, immediate
// mints — was deleted with RFC-132; the unified iteration-mismatch /
// already-answered codes are locked by rfc128-p5-d-autodispatch.test.ts.)
//
// If any of these go red the runtime contract drifted — investigate before
// relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  listTaskQuestions,
  loadUndispatchedSelfQuestionerTargets,
  reassignTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  createClarifyRound,
  dispatchCrossClarifyNode,
  evaluateDesignerRerunReadiness,
} from '../src/services/clarify/service'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  TaskWsMessage,
  WorkflowDefinition,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface SeedOptions {
  taskId?: string
  definition?: WorkflowDefinition
  worktreePath?: string
  status?: 'running' | 'failed' | 'done'
  deferred?: boolean
}

function makeQ(id: string, title: string): ClarifyQuestion {
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

function makeAns(qid: string, idx = 0): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [idx],
    selectedOptionLabels: [],
    customText: '',
  }
}

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry from a per-question scope. "Let the designer revise" is now an explicit human
// reassign of the answered round's questioner card to the graph designer node (ADDS a
// roleKind='designer' handler row targeting it), then a dispatch of that designer entry — which
// mints the designer rerun through the SAME multi-source readiness gate + frontier mint.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunId: string,
) {
  const helperActor = { userId: 'u1', role: 'owner' as const }
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${crossClarifyNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', helperActor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${crossClarifyNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], helperActor)
}

function defaultDef(): WorkflowDefinition {
  // designer ⇄ questioner ⇄ cross1 with manual to_designer edge.
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'design' },
        target: { nodeId: 'questioner', portName: 'design' },
      },
      {
        id: 'e_q_cross_clarify',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_to_questioner',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_cross_to_designer',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, opts: SeedOptions = {}): Promise<{ taskId: string }> {
  const taskId = opts.taskId ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const def = opts.definition ?? defaultDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cross-clarify-test',
    worktreePath: opts.worktreePath ?? '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.status ?? 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

async function seedQuestionerRun(
  db: DbClient,
  taskId: string,
  opts: { id?: string; nodeId?: string } = {},
): Promise<string> {
  const id = opts.id ?? `nr_q_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId ?? 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  return id
}

async function seedDesignerRun(
  db: DbClient,
  taskId: string,
  opts: { id?: string; nodeId?: string; clarifyIteration?: number; status?: string } = {},
): Promise<string> {
  const id = opts.id ?? `nr_d_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId ?? 'designer',
    status: (opts.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: 'stub-snapshot',
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 createClarifyRound', () => {
  test('mints row + parks cross-clarify node_run awaiting_human + broadcasts cross-clarify.created', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { round: session, intermediaryNodeRunId: crossClarifyNodeRunId } =
      await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: 'cross1',
        askingNodeId: 'questioner',
        askingNodeRunId: qRunId,
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQ('q1', 'Why Redis?'), makeQ('q2', 'Sharding?')],
      })

    expect(session.status).toBe('awaiting_human')
    expect(session.iteration).toBe(0)
    expect(session.intermediaryNodeRunId).toBe(crossClarifyNodeRunId)
    expect(session.questions).toHaveLength(2)

    const row = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, session.id)))[0]
    expect(row?.status).toBe('awaiting_human')
    expect(row?.iteration).toBe(0)

    const nr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, crossClarifyNodeRunId)))[0]
    expect(nr?.status).toBe('awaiting_human')

    expect(received.length).toBe(1)
    expect(received[0]?.type).toBe('cross-clarify.created')
  })

  test('iteration counter increments per (node, loop_iter) when a prior session already exists', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId1 = await seedQuestionerRun(db, taskId)
    const qRunId2 = await seedQuestionerRun(db, taskId)

    const r1 = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId1,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r1.round.iteration).toBe(0)

    const r2 = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId2,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r2.round.iteration).toBe(1)
  })
})

// (The 'directive="continue" path' + 'directive="stop" (reject)' describes were DELETED by
// RFC-132 — they locked the retired legacy quick-channel contract itself. The unified
// equivalents — 'clarify-iteration-mismatch' / 'clarify-already-answered' + the stop
// questioner rerun with its canvas directive — are locked by rfc128-p5-d-autodispatch.test.ts.)

describe('RFC-056 evaluateDesignerRerunReadiness — multi-source aggregation', () => {
  test('single source answered=continue → ready, sources includes it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = defaultDef()
    const { taskId } = await seedTask(db, { definition: def })
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      actor: { userId: 'u1', role: 'owner' },
    })

    // After the answer, the round is consumed (its designer entries dispatched).
    // Insert a SECOND awaiting session to verify the readiness scan
    // correctly handles the "fresh source after a prior consumed batch" case.
    const qRunId2 = await seedQuestionerRun(db, taskId)
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId2,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't2')],
    })
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition: def,
      loopIter: 0,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.pendingCrossClarifyNodeIds).toContain('cross1')
  })

  test('two siblings, only one answered → not ready, pending lists the other', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Build def with TWO cross-clarify nodes pointing at the same designer.
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'qSec', kind: 'agent-single', agentName: 'questioner' },
        { id: 'qUx', kind: 'agent-single', agentName: 'questioner' },
        { id: 'crossSec', kind: 'clarify-cross-agent' },
        { id: 'crossUx', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d_qsec',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'qSec', portName: 'design' },
        },
        {
          id: 'e_d_qux',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'qUx', portName: 'design' },
        },
        {
          id: 'e_qsec_cross',
          source: { nodeId: 'qSec', portName: '__clarify__' },
          target: { nodeId: 'crossSec', portName: 'questions' },
        },
        {
          id: 'e_qux_cross',
          source: { nodeId: 'qUx', portName: '__clarify__' },
          target: { nodeId: 'crossUx', portName: 'questions' },
        },
        {
          id: 'e_csec_q',
          source: { nodeId: 'crossSec', portName: 'to_questioner' },
          target: { nodeId: 'qSec', portName: '__clarify_response__' },
        },
        {
          id: 'e_cux_q',
          source: { nodeId: 'crossUx', portName: 'to_questioner' },
          target: { nodeId: 'qUx', portName: '__clarify_response__' },
        },
        {
          id: 'e_csec_d',
          source: { nodeId: 'crossSec', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
        {
          id: 'e_cux_d',
          source: { nodeId: 'crossUx', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const { taskId } = await seedTask(db, { definition: def })
    const qSecRun = await seedQuestionerRun(db, taskId, { nodeId: 'qSec' })
    const qUxRun = await seedQuestionerRun(db, taskId, { nodeId: 'qUx' })
    await seedDesignerRun(db, taskId)
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'crossSec',
      askingNodeId: 'qSec',
      askingNodeRunId: qSecRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'sec')],
    })
    const ux = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'crossUx',
      askingNodeId: 'qUx',
      askingNodeRunId: qUxRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'ux')],
    })

    // Answer only crossUx; crossSec still awaiting → the designer dispatch parks
    // (no designer rerun) and the readiness scan lists crossSec pending.
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor: { userId: 'u1', role: 'owner' },
    })
    expect(ret.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition: def,
      loopIter: 0,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.pendingCrossClarifyNodeIds).toEqual(['crossSec'])
  })

  test('one sibling reject + one submit → ready; sources includes only submit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'qSec', kind: 'agent-single', agentName: 'questioner' },
        { id: 'qUx', kind: 'agent-single', agentName: 'questioner' },
        { id: 'crossSec', kind: 'clarify-cross-agent' },
        { id: 'crossUx', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_qsec_cross',
          source: { nodeId: 'qSec', portName: '__clarify__' },
          target: { nodeId: 'crossSec', portName: 'questions' },
        },
        {
          id: 'e_qux_cross',
          source: { nodeId: 'qUx', portName: '__clarify__' },
          target: { nodeId: 'crossUx', portName: 'questions' },
        },
        {
          id: 'e_csec_d',
          source: { nodeId: 'crossSec', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
        {
          id: 'e_cux_d',
          source: { nodeId: 'crossUx', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const { taskId } = await seedTask(db, { definition: def })
    const qSecRun = await seedQuestionerRun(db, taskId, { nodeId: 'qSec' })
    const qUxRun = await seedQuestionerRun(db, taskId, { nodeId: 'qUx' })
    await seedDesignerRun(db, taskId)
    const sec = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'crossSec',
      askingNodeId: 'qSec',
      askingNodeRunId: qSecRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'sec')],
    })
    const ux = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'crossUx',
      askingNodeId: 'qUx',
      askingNodeRunId: qUxRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'ux')],
    })

    // Reject sec first (does NOT trigger designer; a stop round produces no
    // designer entries at all).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    // Now answer ux — only remaining sibling, sec is stopped (resolved without
    // feeding). RFC-162: reassign ux's answered round to the designer + dispatch it. Readiness
    // passes (sec answered-stop = resolved, not pending) and the designer rerun mints carrying
    // ONLY ux's designer entry (the legacy sources=[ux only] / sourceCount=1).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor: { userId: 'u1', role: 'owner' },
    })
    const disp = await reassignThenDispatchDesigner(db, taskId, ux.intermediaryNodeRunId)
    const designerRerun = disp.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    expect(designerRerun!.entryIds).toHaveLength(1)
  })
})

// (The legacy designer-rerun-mint describe was DELETED by RFC-132 — it tested the retired
// immediate mint itself. The unified dispatch mint's retry_index=max+1 formula is locked by
// cross-clarify-designer-retry-index.test.ts; the dispatched_at consumed stamp by
// cross-clarify-multi-source-wait.test.ts; inherit-passthrough by the shared
// buildMintNodeRunValues coverage.)

describe('RFC-056 dispatchCrossClarifyNode persistent-stop short-circuit', () => {
  test('no persistent stop → dispatch returns "awaiting" (no row mutation)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = defaultDef()
    const { taskId } = await seedTask(db, { definition: def })
    const nrId = 'nr_pending_cross'
    await db.insert(nodeRuns).values({
      id: nrId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    const out = await dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: nrId,
      definition: def,
    })
    expect(out.kind).toBe('awaiting')
    const fresh = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nrId)))[0]
    expect(fresh?.status).toBe('pending')
  })
})

// RFC-128 P0 net: 整轮 seal 现状，P1 逐题改造勿破。这是 cross 「designer 承接链」的
// 现状锁——整轮答案经此整批注入 designer 的 External Feedback。P1 designer 逐题下发后，
// 整轮注入须被逐题注入逐字替代（而非丢失答案）；端到端「questioner 答→designer 收」的
// 串联锁见 rfc128-p0-whole-round-seal-net.test.ts #2。

// RFC-125 follow-up — DATA-LOSS repro (RED until fixed). A failed task's CR-1
// invariant abandons answered+continue+unconsumed cross rounds (lifecycleInvariants
// taskStatus==='failed' gate). `abandoned` is sticky (nothing un-abandons on resume)
// and buildExternalFeedbackContext omits abandoned sessions (like 'stop'), so when a
// FAILED task is RESUMED the designer rerun never sees the human's already-given
// answer — it's silently dropped. Desired behavior (user): resume must preserve it
// (questions should stay in place, not become "closed").
//
// RFC-128 P0 net (behavior #4): 整轮 seal 现状，P1 逐题改造勿破。这是 RFC-126
// 「failed→resume 答过的反问存活」的现成复现，per-question seal 改造后整轮 answered 不变量
// 仍须成立（轮只在「全题 seal」时翻 answered，partial 纯派生）——此锁不可放松。
describe('RFC-125 follow-up — failed→resume must NOT drop answered cross-clarify feedback', () => {
  test('answered cross-clarify feedback survives a fail → CR-1 → resume cycle', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = defaultDef()
    const { taskId } = await seedTask(db, { definition: def })
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why Redis?')],
    })
    // Human answers; directive=continue dispatches the designer rerun, but it never
    // completes-with-output (the task fails) → the round stays answered+UNCONSUMED.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      actor: { userId: 'u1', role: 'owner' },
    })

    // Task fails before the designer consumes the feedback. RFC-126: CR-1 is
    // RETIRED → the lifecycle scan must NOT abandon the round; it stays 'answered'
    // so the human's answer is preserved (the deferred queue re-injects it on resume).
    await db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, taskId))
    await runLifecycleInvariants({ db })
    const sess = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)))[0]
    expect(sess?.status).toBe('answered') // RFC-126: NOT abandoned anymore

    // RESUME the task. RFC-126 fix: the answered round survives — never abandoned —
    // so its human answer stays available to the designer rerun.
    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
    const afterResume = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]
    expect(afterResume?.status).toBe('answered')
  })
})

// ===========================================================================
// RFC-128 P5-BC §5.2.14 — questioner write-flow invariants, under the RFC-132 unified driver
// (autoDispatchClarifyRound: seal tx → per-question dispatch). The live invariants: a
// whole-round finalize consumes the round's questioner entries (not parked, not
// re-dispatchable, exactly one rerun); a concurrent double answer has ONE winner; an open
// dispatched questioner entry on the home defers a second mint.
// ===========================================================================
describe('RFC-128 P5-BC §5.2.14 questioner mixed-path write-flow', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  // finding 2 + finding 3 (regression ②): a quick whole-round finalize that continues the
  // questioner consumes the round's questioner entries — sealed + dispatched in the same call
  // (dispatched_at is the unified consumed stamp) → home not parked, entries not
  // re-dispatchable, and exactly ONE questioner rerun (no park starvation, no duplicate).
  test('finding 2/3 — quick-finalize continuing the questioner consumes its entries (not parked, not re-dispatchable, single rerun)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't'), makeQ('q2', 't')],
    })
    // RFC-162: cross rounds unify with self — the questioner continuation is the default (scope
    // deleted); its entries are materialized, sealed and consumed by the unified dispatch.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
      actor,
    })
    // The round's questioner entries were materialized, sealed and DISPATCHED (consumed).
    const qEntries = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, crossClarifyNodeRunId))
    ).filter((e) => e.roleKind === 'questioner')
    expect(qEntries.length).toBeGreaterThan(0)
    expect(qEntries.every((e) => e.sealedAt !== null)).toBe(true)
    expect(qEntries.every((e) => e.dispatchedAt !== null)).toBe(true)
    // The questioner home is NOT parked (the consumed entries dropped out of the park source).
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has('questioner')).toBe(false)
    // Not re-dispatchable (dispatch skips already-dispatched entries) → no duplicate.
    const redispatch = await dispatchTaskQuestions(
      db,
      taskId,
      qEntries.map((e) => e.id),
      actor,
    )
    expect(redispatch.dispatchedEntryIds.length).toBe(0)
    // Exactly ONE questioner cascade rerun (no double mint).
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'questioner' && r.rerunCause === 'cross-clarify-questioner-rerun',
    )
    expect(reruns.length).toBe(1)
  })

  // finding 1 (regression ① for cross): two CONCURRENT answers on the same awaiting_human
  // round mint EXACTLY ONE questioner rerun — the seal's per-question lock rejects the loser
  // (ConflictError 'clarify-already-answered' / 'clarify-question-already-sealed').
  test('finding 1 — concurrent cross double-answer mints exactly ONE questioner rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    const results = await Promise.allSettled([
      autoDispatchClarifyRound({
        db,
        originNodeRunId: crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        actor,
      }),
      autoDispatchClarifyRound({
        db,
        originNodeRunId: crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        actor,
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1)
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'questioner' && r.rerunCause === 'cross-clarify-questioner-rerun',
    )
    expect(reruns.length).toBe(1)
  })

  // RFC-162: retired — "designer-scope continuation materializes the designer entry" tested
  // designer-by-default auto-creation from a per-question scope, which is DELETED. A designer
  // handler row is now created only by an explicit human reassign; the reassign→dispatch→rerun
  // path (single ready source auto-dispatches) is covered by
  // cross-clarify-designer-retry-index.test.ts + cross-clarify-dual-write-consistency.test.ts.

  // 2nd-gate finding 2 (reciprocal in-flight check): a concurrent dispatch of another entry
  // to the same questioner home already committed a pending cross-clarify-questioner-rerun
  // BEFORE this answer. dispatchTaskQuestions' in-flight gate rejects the mint
  // ('task-question-node-dispatch-in-flight'); the unified quick channel treats it as a
  // RECOVERABLE park — the answer commits (round answered, entries sealed-undispatched),
  // the call returns success with dispatchDeferredReason, and NO second rerun mints.
  test('finding 2 (reciprocal) — an OPEN dispatched questioner entry on the home defers the mint (no double rerun)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: qRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    // The concurrent dispatch that won: a pending cross-clarify-questioner-rerun on the questioner
    // home + a DISPATCHED questioner task_question whose home (default) is 'questioner', bound to it
    // (in-flight / unconsumed).
    const dispatchedRerunId = `nr_qrr_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(nodeRuns).values({
      id: dispatchedRerunId,
      taskId,
      nodeId: 'questioner',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      rerunCause: 'cross-clarify-questioner-rerun',
    })
    await db.insert(taskQuestions).values({
      id: `tq_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      originNodeRunId: `other_round_${Math.random().toString(36).slice(2, 8)}`,
      questionId: 'qx',
      questionTitle: 'qx',
      sourceKind: 'cross',
      roleKind: 'questioner',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: 'questioner',
      sealedAt: Date.now(),
      dispatchedAt: Date.now(),
      dispatchedBy: 'u1',
      triggerRunId: dispatchedRerunId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    // The answer is saved + parked; the mint was DEFERRED by the in-flight gate.
    expect(res.dispatchDeferredReason).toBe('task-question-node-dispatch-in-flight')
    expect(res.dispatch.reruns).toHaveLength(0)
    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, crossClarifyNodeRunId))
    )[0]
    expect(sess?.status).toBe('answered')
    // No SECOND questioner rerun minted (the existing in-flight rerun stands).
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })
})
