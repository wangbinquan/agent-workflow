// RFC-056 PR-D C4 — reject persistence cross-cascade 守门.
//
// `directive='stop'` (Reject) on a cross-clarify session sets a row that
// persists across ALL subsequent cascade reset / sibling-submit /
// self-clarify-iterate scenarios. Once a (task_id, cross_clarify_node_id)
// pair sees one stopped session, the cross-clarify node permanently
// short-circuits to done — the questioner never produces another
// awaiting_human row for that node id, and `hasPersistentStop()` keeps
// returning true regardless of what happens around it.
//
// LOCKS:
//   1. After one reject on cross1, hasPersistentStop(task, 'cross1') is true.
//   2. Persistence survives a sibling cross-clarify submit on a different
//      cross node (cross2) — hasPersistentStop(task, 'cross1') still true.
//   3. Persistence survives a designer self-clarify iterate on the same
//      designer node — hasPersistentStop(task, 'cross1') still true.
//   4. Persistence is keyed by (task, node_id) — a different cross node
//      remains unaffected.
//   5. dispatchCrossClarifyNode on a fresh node_run for the stopped node
//      always returns 'short-circuit-stop' (no new awaiting_human session).
//
// If any of these go red the cross-cascade reject contract drifted — the
// user's "I refuse to be asked again" intent is being lost — investigate
// before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { insertLegacySelfClarify } from './clarify-fixtures'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  createClarifyRound,
  dispatchCrossClarifyNode,
  resolveCrossNodeStopped,
} from '../src/services/clarify/service'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

function twoCrossDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'qA', kind: 'agent-single', agentName: 'questioner' },
      { id: 'qB', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
      { id: 'cross2', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_qA_cross1',
        source: { nodeId: 'qA', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_qB_cross2',
        source: { nodeId: 'qB', portName: '__clarify__' },
        target: { nodeId: 'cross2', portName: 'questions' },
      },
      {
        id: 'e_c1_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_c2_d',
        source: { nodeId: 'cross2', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = twoCrossDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'reject-persistence',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc056-c4',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedQRun(db: DbClient, taskId: string, nodeId: string): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  return id
}

async function seedDesignerRun(db: DbClient, taskId: string): Promise<string> {
  const id = `nr_d_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: 'snap-c4',
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 C4 — reject persistence cross-cascade', () => {
  test('after one reject on cross1, resolveCrossNodeStopped(task, qA) is true', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId)
    const qA = await seedQRun(db, taskId, 'qA')
    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'qA',
      askingNodeRunId: qA,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor,
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'qA')).toBe(true)
    expect(await resolveCrossNodeStopped(db, taskId, 'qB')).toBe(false)
  })

  test('persistence survives a sibling cross-clarify submit on a different cross node', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId)
    const qA = await seedQRun(db, taskId, 'qA')
    const qB = await seedQRun(db, taskId, 'qB')
    // Reject on cross1.
    const a = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'qA',
      askingNodeRunId: qA,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: a.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor,
    })
    // Sibling cross2 submits continue — unrelated.
    const b = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross2',
      askingNodeId: 'qB',
      askingNodeRunId: qB,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: b.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'qA')).toBe(true)
  })

  test('persistence survives a designer self-clarify iterate on the same designer node', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId)
    const qA = await seedQRun(db, taskId, 'qA')
    const a = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'qA',
      askingNodeRunId: qA,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: a.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor,
    })
    // Simulate a parallel self-clarify session on the designer — unrelated.
    const designerSelfClarifyNrId = `nr_d_self_${Math.random().toString(36).slice(2, 6)}`
    await db.insert(nodeRuns).values({
      id: designerSelfClarifyNrId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertLegacySelfClarify(db, {
      id: `cs_${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: designerSelfClarifyNrId,
      sourceShardKey: null,
      clarifyNodeId: 'designerSelfClarifyNode',
      clarifyNodeRunId: designerSelfClarifyNrId,
      iterationIndex: 0,
      questionsJson: JSON.stringify([{ id: 'q', title: 't', kind: 'single', options: [] }]),
      answersJson: '[]',
      status: 'answered',
      createdAt: Date.now(),
      answeredAt: Date.now(),
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'qA')).toBe(true)
  })

  test('persistence is keyed by (task, node_id) — a different cross node remains unaffected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId)
    const qA = await seedQRun(db, taskId, 'qA')
    const a = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'qA',
      askingNodeRunId: qA,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: a.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor,
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'qA')).toBe(true)
    expect(await resolveCrossNodeStopped(db, taskId, 'qB')).toBe(false)
  })

  test('dispatchCrossClarifyNode on a fresh node_run for the stopped node short-circuits to done (no new awaiting session)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerRun(db, taskId)
    const qA = await seedQRun(db, taskId, 'qA')
    const a = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'qA',
      askingNodeRunId: qA,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: a.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor,
    })

    // Mint a fresh pending cross-clarify node_run and dispatch it; service
    // must short-circuit it to done.
    const freshId = `nr_cross1_${Math.random().toString(36).slice(2, 6)}`
    await db.insert(nodeRuns).values({
      id: freshId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    const ret = await dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: freshId,
      definition: twoCrossDef(),
    })
    expect(ret.kind).toBe('short-circuit-stop')

    const finalRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, freshId)))[0]
    expect(finalRun?.status).toBe('done')
  })
})
