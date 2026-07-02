// RFC-056 PR-B T5 — lock the cross-clarify service contract.
//
// LOCKS:
//   1. createCrossClarifySession round-trips a row, parks cross-clarify
//      node_run at awaiting_human, broadcasts 'cross-clarify.created'.
//   2. submitCrossClarifyAnswers + directive='continue':
//        a) ifMatchIteration optimistic lock fires 409 on mismatch.
//        b) idempotency: re-submit on answered row → 409.
//        c) seals selectedOptionLabels server-side (RFC-023 defence reuse).
//        d) directive='stop' branch mints fresh questioner node_run +
//           broadcasts 'cross-clarify.rejected', does NOT mint designer rerun.
//   3. evaluateDesignerRerunReadiness:
//        a) single source resolved → ready, sources=[that one].
//        b) two siblings pointing at same designer, only one answered → not
//           ready, pendingCrossClarifyNodeIds = [the other].
//        c) one sibling rejected (directive='stop'), the other submitted →
//           ready with sources containing only the submitted one.
//   4. triggerDesignerRerun mints new designer node_run at
//      cross_clarify_iteration+1, retry_index=0; preserves shard/parent
//      passthrough; stamps designer_run_triggered_at on consumed sessions.
//   5. dispatchCrossClarifyNode short-circuits to done when a prior
//      directive='stop' session exists (persistent stop check is by
//      cross_clarify_node_id alone, irrespective of loop_iter).
//   6. buildExternalFeedbackContext renders only directive='continue'
//      sessions for the same loop_iter; sorts sources by node id; omits
//      stopped + abandoned siblings.
//
// If any of these go red the runtime contract drifted — investigate before
// relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { loadUndispatchedSelfQuestionerTargets } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import {
  createCrossClarifySession,
  dispatchCrossClarifyNode,
  evaluateDesignerRerunReadiness,
  resolveCrossNodeStopped,
  submitCrossClarifyAnswers,
  triggerDesignerRerun,
} from '../src/services/crossClarify'
import { reconcileLegacyCrossPersistentStop } from '../src/services/clarifyMigration'
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
    deferredQuestionDispatch: opts.deferred ?? false,
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

describe('RFC-056 createCrossClarifySession', () => {
  test('mints row + parks cross-clarify node_run awaiting_human + broadcasts cross-clarify.created', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { session, crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why Redis?'), makeQ('q2', 'Sharding?')],
    })

    expect(session.status).toBe('awaiting_human')
    expect(session.iteration).toBe(0)
    expect(session.crossClarifyNodeRunId).toBe(crossClarifyNodeRunId)
    expect(session.questions).toHaveLength(2)

    const row = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, session.id))
    )[0]
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

    const r1 = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId1,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r1.session.iteration).toBe(0)

    const r2 = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId2,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r2.session.iteration).toBe(1)
  })
})

describe('RFC-056 submitCrossClarifyAnswers — directive="continue" path', () => {
  test('ifMatchIteration mismatch → 409 cross-clarify-iteration-mismatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })

    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        ifMatchIteration: 99,
      }),
    ).rejects.toMatchObject({ code: 'cross-clarify-iteration-mismatch' })
  })

  test('second submit on answered row → 409 cross-clarify-already-answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
      }),
    ).rejects.toMatchObject({ code: 'cross-clarify-already-answered' })
  })

  test('seals selectedOptionLabels server-side from question.options (anti-forgery)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why?')],
    })
    const { session } = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['BogusLabelClient'], // attempt forgery
          customText: '',
        },
      ],
      directive: 'continue',
    })
    expect(session.answers?.[0]?.selectedOptionLabels).toEqual(['A'])
  })
})

// RFC-128 P0 net: 整轮 seal 现状，P1 逐题改造勿破。本 describe 锁住 stop 路径整轮
// 续跑（mint 一条 questioner node_run + designer 不续跑）；cause 字段与「恰好一条」的
// 补强锁见 rfc128-p0-whole-round-seal-net.test.ts #2。
describe('RFC-056 submitCrossClarifyAnswers — directive="stop" (reject)', () => {
  test('mints fresh questioner node_run + broadcasts cross-clarify.rejected; designer NOT rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'spurious?')],
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })
    expect(result.outcome.kind).toBe('questioner-stop-triggered')

    const rejectedBroadcast = received.find((m) => m.type === 'cross-clarify.rejected')
    expect(rejectedBroadcast).toBeDefined()
    const batched = received.find((m) => m.type === 'cross-clarify.designer-rerun-batched')
    expect(batched).toBeUndefined()

    // A new questioner node_run with status='pending' must exist.
    const qRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const pendingQuestioner = qRuns.find((r) => r.nodeId === 'questioner' && r.status === 'pending')
    expect(pendingQuestioner).toBeDefined()

    // No new designer node_run at cross_clarify_iteration=1 should exist.
    const newDesigner = qRuns.find((r) => r.nodeId === 'designer' && r.status === 'pending')
    expect(newDesigner).toBeUndefined()
  })
})

describe('RFC-056 evaluateDesignerRerunReadiness — multi-source aggregation', () => {
  test('single source answered=continue → ready, sources includes it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = defaultDef()
    const { taskId } = await seedTask(db, { definition: def })
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    // After submit, the latest session is consumed (designer_run_triggered_at
    // stamped). Insert a SECOND awaiting session to verify the readiness scan
    // correctly handles the "fresh source after a prior consumed batch" case.
    const qRunId2 = await seedQuestionerRun(db, taskId)
    await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId2,
      targetDesignerNodeId: 'designer',
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
    await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'crossSec',
      sourceQuestionerNodeId: 'qSec',
      sourceQuestionerNodeRunId: qSecRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'sec')],
    })
    const ux = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'crossUx',
      sourceQuestionerNodeId: 'qUx',
      sourceQuestionerNodeRunId: qUxRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'ux')],
    })

    // Submit only crossUx; crossSec still awaiting.
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-waiting')
    if (ret.outcome.kind === 'designer-waiting') {
      expect(ret.outcome.pendingCrossClarifyNodeIds).toEqual(['crossSec'])
    }
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
    const sec = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'crossSec',
      sourceQuestionerNodeId: 'qSec',
      sourceQuestionerNodeRunId: qSecRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'sec')],
    })
    const ux = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'crossUx',
      sourceQuestionerNodeId: 'qUx',
      sourceQuestionerNodeRunId: qUxRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'ux')],
    })

    // Reject sec first (does NOT trigger designer).
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })
    // Now submit ux — only remaining sibling, sec is stopped (resolved
    // without feeding). Readiness should pass with sources=[ux only].
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    if (ret.outcome.kind === 'designer-rerun-triggered') {
      expect(ret.outcome.sourceCount).toBe(1)
    }
  })
})

describe('RFC-056 triggerDesignerRerun', () => {
  test('mints new designer node_run with cross_clarify_iteration+1, retry_index=max(existing)+1; stamps designer_run_triggered_at', async () => {
    // Patch 2026-05-23: retry_index is now max(existing top-level rows at
    // this iteration) + 1 (not hardcoded 0) so the scheduler's
    // `isFresherNodeRun` ALWAYS picks the new pending row over any prior
    // done row at the same clarifyIteration. With a single prior designer
    // row at retry_index=0 the bump yields retry_index=1.
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId, { clarifyIteration: 0 })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'go')],
    })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    if (ret.outcome.kind !== 'designer-rerun-triggered') return

    const newDesigner = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, ret.outcome.designerNodeRunId))
    )[0]
    expect(newDesigner?.retryIndex).toBe(1)
    expect(newDesigner?.status).toBe('pending')

    // The consumed session has designer_run_triggered_at set.
    const row = (
      await db
        .select()
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    )[0]
    expect(row?.designerRunTriggeredAt).not.toBeNull()
  })

  test('preserves shard_key + parent_node_run_id passthrough on designer rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_designer_with_shard',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: 'snap',
      parentNodeRunId: 'parent-x',
      shardKey: 'shardA',
    })
    const out = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 0,
    })
    const fresh = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, out.designerNodeRunId))
    )[0]
    expect(fresh?.shardKey).toBe('shardA')
    expect(fresh?.parentNodeRunId).toBe('parent-x')
  })
})

describe('RFC-056 dispatchCrossClarifyNode persistent-stop short-circuit', () => {
  test('cross-clarify node_run flips pending → done when a prior directive=stop session exists for the same node_id (any loop_iter)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = defaultDef()
    const { taskId } = await seedTask(db, { definition: def })
    const qRunId = await seedQuestionerRun(db, taskId)
    await seedDesignerRun(db, taskId)
    // Seed a directive='stop' row directly (simulating prior reject).
    await db.insert(crossClarifySessions).values({
      id: 'old-stop',
      taskId,
      crossClarifyNodeId: 'cross1',
      crossClarifyNodeRunId: (
        await createCrossClarifySession({
          db,
          taskId,
          crossClarifyNodeId: 'cross1',
          sourceQuestionerNodeId: 'questioner',
          sourceQuestionerNodeRunId: qRunId,
          targetDesignerNodeId: 'designer',
          loopIter: 0,
          questions: [makeQ('q1', 't')],
        })
      ).crossClarifyNodeRunId, // any valid node_run row, just to satisfy FK
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 99,
      questionsJson: '[]',
      answersJson: '[]',
      directive: 'stop',
      status: 'answered',
      createdAt: Date.now(),
      answeredAt: Date.now(),
    })

    // RFC-132 T7: a legacy crossClarifySessions.directive='stop' (written pre-migration, with no
    // node-level directive) is reconciled onto the questioner node's node-level directive by the
    // boot migration shim; resolveCrossNodeStopped / dispatchCrossClarifyNode then read it.
    await reconcileLegacyCrossPersistentStop(db)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner')).toBe(true)

    // Now mint a fresh cross-clarify node_run pending and dispatch it.
    const nrId = `nr_cross_${Math.random().toString(36).slice(2, 8)}`
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
    expect(out.kind).toBe('short-circuit-stop')
    const fresh = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nrId)))[0]
    expect(fresh?.status).toBe('done')
  })

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
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why Redis?')],
    })
    // Human answers; directive=continue triggers the designer rerun, but it never
    // completes-with-output (the task fails) → the round stays answered+UNCONSUMED.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    // Task fails before the designer consumes the feedback. RFC-126: CR-1 is
    // RETIRED → the lifecycle scan must NOT abandon the round; it stays 'answered'
    // so the human's answer is preserved (the deferred queue re-injects it on resume).
    await db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, taskId))
    await runLifecycleInvariants({ db })
    const sess = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.taskId, taskId))
    )[0]
    expect(sess?.status).toBe('answered') // RFC-126: NOT abandoned anymore

    // RESUME the task. RFC-126 fix: the answered round survives — never abandoned —
    // so its human answer stays available to the designer rerun.
    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
    const afterResume = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.taskId, taskId))
    )[0]
    expect(afterResume?.status).toBe('answered')
  })
})

// ===========================================================================
// RFC-128 P5-BC §5.2.14 — questioner mixed-path write-flow (findings 1+2+3 for the cross/questioner
// submit). Mirrors the self path: the cross submit's flip runs in a dbTxSync with a session CAS +
// dispatch-mode recheck + (when the questioner is cascaded) reconcile+consume of the round's
// QUESTIONER entries; the async questioner cascade / designer logic stay after the tx.
// ===========================================================================
describe('RFC-128 P5-BC §5.2.14 questioner mixed-path write-flow', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  // finding 2 + finding 3 (regression ②): a quick whole-round finalize that CASCADES the questioner
  // (all-questioner-scope fast path) consumes the round's questioner entries — they are superseded by
  // the cascade. Materialized + confirmed in-tx → home not parked, entries not re-dispatchable, and
  // exactly ONE questioner rerun (no park starvation, no duplicate). Virgin case (no prior seal):
  // the in-tx reconcile creates the questioner entries so a later lazy reconcile can't revive them.
  test('finding 2/3 — quick-finalize cascading the questioner consumes its entries (not parked, not re-dispatchable, single rerun)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't'), makeQ('q2', 't')],
    })
    // All-questioner-scope → RFC-059 fast path → the questioner is cascaded → its entries superseded.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
      directive: 'continue',
      questionScopes: { q1: 'questioner', q2: 'questioner' },
    })
    // The round's questioner entries were materialized + confirmed (superseded).
    const qEntries = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, crossClarifyNodeRunId))
    ).filter((e) => e.roleKind === 'questioner')
    expect(qEntries.length).toBeGreaterThan(0)
    expect(qEntries.every((e) => e.confirmation === 'confirmed')).toBe(true)
    // The questioner home is NOT parked (the superseded entries dropped out of the park source).
    expect((await loadUndispatchedSelfQuestionerTargets(db, taskId)).has('questioner')).toBe(false)
    // Not re-dispatchable (dispatch skips confirmed) → no duplicate.
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

  // finding 1 (regression ① for cross): two CONCURRENT submitCrossClarifyAnswers on the same
  // awaiting_human session mint EXACTLY ONE questioner rerun — the in-tx session CAS rejects the loser.
  test('finding 1 — concurrent cross double-submit mints exactly ONE questioner rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    const results = await Promise.allSettled([
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        questionScopes: { q1: 'questioner' },
      }),
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        questionScopes: { q1: 'questioner' },
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1)
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'questioner' && r.rerunCause === 'cross-clarify-questioner-rerun',
    )
    expect(reruns.length).toBe(1)
  })

  // §5.2.14 final-gate (2nd round) finding 1 (regression ①): a deferred-DESIGNER continuation (a
  // designer-scope question on a deferred task) MATERIALIZES the round's designer task_questions IN the
  // same B-protected tx as the answered flip — so after the submit returns, the answered session AND
  // the undispatched designer row are BOTH committed (atomic; a concurrent dispatch / scheduler park
  // never sees the answered round row-less). Was a post-lock reconcile (separate tx) → non-atomic window.
  test('finding 1 — deferred designer continuation materializes the designer entry atomically with the flip', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    const res = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
      questionScopes: { q1: 'designer' },
    })
    // deferred designer outcome (NOT triggered immediately).
    expect(res.outcome.kind).toBe('designer-deferred')
    // the session is answered AND the designer task_question row exists (undispatched / staged) — both
    // committed by the single flip tx.
    const sess = (
      await db
        .select()
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    )[0]
    expect(sess?.status).toBe('answered')
    const designerRows = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, crossClarifyNodeRunId))
    ).filter((e) => e.roleKind === 'designer' && e.questionId === 'q1')
    expect(designerRows.length).toBe(1)
    expect(designerRows[0]!.dispatchedAt).toBeNull() // deferred → staged, not dispatched
  })

  // 2nd-gate finding 2 (reciprocal in-flight check): a concurrent deferred dispatch of another staged
  // entry to the same questioner home already committed a pending cross-clarify-questioner-rerun
  // BEFORE this cascade's tx. The dispatch-mode recheck only sees THIS round's entries, so the
  // reciprocal in-tx in-flight check blocks the cascade mint → no double questioner rerun.
  test('finding 2 (reciprocal) — an OPEN dispatched questioner entry on the home blocks the cascade mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, { deferred: true })
    const qRunId = await seedQuestionerRun(db, taskId)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
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
    let caught: unknown
    try {
      await submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        questionScopes: { q1: 'questioner' },
      })
    } catch (e) {
      caught = e
    }
    expect((caught as { code?: string } | undefined)?.code).toBe(
      'cross-clarify-questioner-rerun-in-flight',
    )
    // No SECOND questioner rerun minted (tx rolled back; the existing in-flight rerun stands).
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(
      runsBefore,
    )
  })
})
