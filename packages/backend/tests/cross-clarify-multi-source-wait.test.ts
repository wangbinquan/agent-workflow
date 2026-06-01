// RFC-056 PR-D C3 — multi-source wait 守门.
//
// When N cross-clarify nodes point at the same designer (via manual
// to_designer → designer.__external_feedback__ edge), the designer is
// allowed to rerun only AFTER every sibling has produced a *resolution*
// (directive='continue' submit OR directive='stop' reject). Partial
// submits keep the designer parked.
//
// LOCKS:
//   1. 3 sibling cross-clarify nodes all pointing at the same designer:
//      submitting 1 of 3 → outcome 'designer-waiting' with the other 2
//      pendingCrossClarifyNodeIds listed.
//   2. Submitting 2 of 3 → still 'designer-waiting', last 1 listed.
//   3. Submitting all 3 → outcome 'designer-rerun-triggered' with
//      sourceCount=3.
//   4. Designer node_runs do NOT gain a new (clarify_iteration+1)
//      row until the final submit lands.
//   5. Final designer rerun consumes ALL three sessions
//      (designer_run_triggered_at non-null on each).
//
// If any of these go red the multi-source aggregation contract drifted —
// investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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

function threeSiblingDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'qSec', kind: 'agent-single', agentName: 'questioner' },
      { id: 'qUx', kind: 'agent-single', agentName: 'questioner' },
      { id: 'qPerf', kind: 'agent-single', agentName: 'questioner' },
      { id: 'crossSec', kind: 'clarify-cross-agent' },
      { id: 'crossUx', kind: 'clarify-cross-agent' },
      { id: 'crossPerf', kind: 'clarify-cross-agent' },
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
        id: 'e_qperf_cross',
        source: { nodeId: 'qPerf', portName: '__clarify__' },
        target: { nodeId: 'crossPerf', portName: 'questions' },
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
      {
        id: 'e_cperf_d',
        source: { nodeId: 'crossPerf', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = threeSiblingDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'multi-source',
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
    repoPath: '/tmp/aw-rfc056-c3',
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
    preSnapshot: 'snap-c3',
  })
  return id
}

async function buildHarness(): Promise<{
  db: DbClient
  taskId: string
  sec: string
  ux: string
  perf: string
}> {
  const db = createInMemoryDb(MIGRATIONS)
  const taskId = await seedTask(db)
  await seedDesignerRun(db, taskId)
  const qSec = await seedQRun(db, taskId, 'qSec')
  const qUx = await seedQRun(db, taskId, 'qUx')
  const qPerf = await seedQRun(db, taskId, 'qPerf')
  const sec = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'crossSec',
    sourceQuestionerNodeId: 'qSec',
    sourceQuestionerNodeRunId: qSec,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  const ux = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'crossUx',
    sourceQuestionerNodeId: 'qUx',
    sourceQuestionerNodeRunId: qUx,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  const perf = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'crossPerf',
    sourceQuestionerNodeId: 'qPerf',
    sourceQuestionerNodeRunId: qPerf,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  return {
    db,
    taskId,
    sec: sec.crossClarifyNodeRunId,
    ux: ux.crossClarifyNodeRunId,
    perf: perf.crossClarifyNodeRunId,
  }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 C3 — multi-source wait', () => {
  test('1/3 submitted → designer-waiting; pending lists the OTHER two', async () => {
    const { db, sec } = await buildHarness()
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-waiting')
    if (ret.outcome.kind === 'designer-waiting') {
      expect(ret.outcome.pendingCrossClarifyNodeIds.sort()).toEqual(['crossPerf', 'crossUx'])
    }
  })

  test('2/3 submitted → still designer-waiting; pending lists the LAST one', async () => {
    const { db, sec, ux } = await buildHarness()
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-waiting')
    if (ret.outcome.kind === 'designer-waiting') {
      expect(ret.outcome.pendingCrossClarifyNodeIds).toEqual(['crossPerf'])
    }
  })

  test('partial submit does NOT create a new designer node_run at higher clarify_iteration', async () => {
    const { db, taskId, sec, ux } = await buildHarness()
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const elevatedDesigner = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.nodeId, 'designer'), eq(nodeRuns.status, 'pending')))
    expect(elevatedDesigner.length).toBe(0)
    void taskId
  })

  test('3/3 submitted → designer-rerun-triggered with sourceCount=3', async () => {
    const { db, sec, ux, perf } = await buildHarness()
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: perf,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    if (ret.outcome.kind === 'designer-rerun-triggered') {
      expect(ret.outcome.sourceCount).toBe(3)
    }
  })

  test('final submit creates exactly ONE elevated designer node_run + consumes ALL 3 sessions', async () => {
    const { db, taskId, sec, ux, perf } = await buildHarness()
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sec,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ux,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: perf,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const elevatedDesigner = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.nodeId, 'designer'), eq(nodeRuns.status, 'pending')))
    expect(elevatedDesigner.length).toBe(1)

    const consumed = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.taskId, taskId))
    expect(consumed.length).toBe(3)
    for (const s of consumed) {
      expect(s.designerRunTriggeredAt).not.toBeNull()
    }
  })
})
