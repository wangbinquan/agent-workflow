// RFC-056 PR-D C3 — multi-source wait 守门.
//
// When N cross-clarify nodes point at the same designer (via manual
// to_designer → designer.__external_feedback__ edge), the designer is
// allowed to rerun only AFTER every sibling has produced a *resolution*
// (directive='continue' answer OR directive='stop' reject). Partial
// answers keep the designer parked.
//
// LOCKS (RFC-132 unified driver — autoDispatchClarifyRound):
//   1. 3 sibling cross-clarify nodes all pointing at the same designer:
//      answering 1 of 3 → its questioner rerun mints but the DESIGNER PARKS
//      (no designer rerun in the dispatch result; readiness lists the other
//      2 as pending).
//   2. Answering 2 of 3 → designer still parked, last 1 pending.
//   3. Answering all 3 → the LAST answer mints ONE designer rerun carrying
//      all 3 siblings' designer entries.
//   4. Designer node_runs do NOT gain a new pending row until the final
//      answer lands.
//   5. Final designer rerun consumes ALL three rounds (dispatched_at
//      non-null on every designer entry — the unified consumed stamp).
//
// If any of these go red the multi-source aggregation contract drifted —
// investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createClarifyRound, evaluateDesignerRerunReadiness } from '../src/services/clarify/service'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry. The N:1 multi-source designer aggregation this file locks is now driven by
// reassigning EACH answered sibling round's questioner card to the shared graph designer node
// (ADDS a roleKind='designer' handler row), then dispatching all the designer entries in ONE
// batch — the readiness gate (all siblings answered) passes and mints ONE designer rerun that
// aggregates every source. The park/pending assertions before all siblings answer are unchanged
// (a not-yet-answered sibling still keeps the designer parked in evaluateDesignerRerunReadiness).
async function reassignAllThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunIds: string[],
) {
  for (const origin of crossClarifyNodeRunIds) {
    const questioner = (await listTaskQuestions(db, taskId)).find(
      (e) => e.roleKind === 'questioner' && e.originNodeRunId === origin,
    )
    if (!questioner) throw new Error(`no questioner entry for round ${origin}`)
    await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  }
  const designerIds = (await listTaskQuestions(db, taskId))
    .filter((e) => e.roleKind === 'designer' && crossClarifyNodeRunIds.includes(e.originNodeRunId!))
    .map((e) => e.id)
  return dispatchTaskQuestions(db, taskId, designerIds, actor)
}

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
  const sec = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: 'crossSec',
    askingNodeId: 'qSec',
    askingNodeRunId: qSec,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  const ux = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: 'crossUx',
    askingNodeId: 'qUx',
    askingNodeRunId: qUx,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  const perf = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: 'crossPerf',
    askingNodeId: 'qPerf',
    askingNodeRunId: qPerf,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1')],
  })
  return {
    db,
    taskId,
    sec: sec.intermediaryNodeRunId,
    ux: ux.intermediaryNodeRunId,
    perf: perf.intermediaryNodeRunId,
  }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 C3 — multi-source wait', () => {
  test('1/3 answered → designer PARKS (no designer rerun); readiness lists the OTHER two pending', async () => {
    const { db, taskId, sec } = await buildHarness()
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec,
      answers: [makeAns('q1')],
      actor,
    })
    // RFC-132 (§6 delta 7): the first sibling's answer mints ITS questioner rerun; the
    // designer dispatch swallows 'task-question-designer-not-ready' and PARKS — no
    // designer rerun in the dispatch result.
    expect(ret.dispatch.reruns.some((r) => r.targetNodeId === 'qSec')).toBe(true)
    expect(ret.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition: threeSiblingDef(),
      loopIter: 0,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.pendingCrossClarifyNodeIds.sort()).toEqual(['crossPerf', 'crossUx'])
  })

  test('2/3 answered → designer still parked; readiness lists the LAST one pending', async () => {
    const { db, taskId, sec, ux } = await buildHarness()
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec,
      answers: [makeAns('q1')],
      actor,
    })
    const ret = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux,
      answers: [makeAns('q1')],
      actor,
    })
    expect(ret.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition: threeSiblingDef(),
      loopIter: 0,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.pendingCrossClarifyNodeIds).toEqual(['crossPerf'])
  })

  test('partial answer does NOT create a new pending designer node_run', async () => {
    const { db, taskId, sec, ux } = await buildHarness()
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec,
      answers: [makeAns('q1')],
      actor,
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux,
      answers: [makeAns('q1')],
      actor,
    })
    const elevatedDesigner = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.nodeId, 'designer'), eq(nodeRuns.status, 'pending')))
    expect(elevatedDesigner.length).toBe(0)
    void taskId
  })

  test('3/3 answered → dispatching the designer entries mints ONE rerun aggregating all 3 sources', async () => {
    const { db, taskId, sec, ux, perf } = await buildHarness()
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec,
      answers: [makeAns('q1')],
      actor,
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux,
      answers: [makeAns('q1')],
      actor,
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: perf,
      answers: [makeAns('q1')],
      actor,
    })
    // RFC-162: reassign all 3 answered rounds to the shared designer + dispatch the batch. ONE
    // designer rerun, carrying every sibling's designer entry (the legacy sourceCount=3 → the
    // rerun's dispatched entry batch spans all 3 rounds).
    const disp = await reassignAllThenDispatchDesigner(db, taskId, [sec, ux, perf])
    const designerRerun = disp.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    expect(designerRerun!.entryIds).toHaveLength(3)
  })

  test('final answer creates exactly ONE elevated designer node_run + consumes ALL 3 rounds', async () => {
    const { db, taskId, sec, ux, perf } = await buildHarness()
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sec,
      answers: [makeAns('q1')],
      actor,
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: ux,
      answers: [makeAns('q1')],
      actor,
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: perf,
      answers: [makeAns('q1')],
      actor,
    })
    // RFC-162: the designer rerun is minted by dispatching the reassigned designer entries.
    await reassignAllThenDispatchDesigner(db, taskId, [sec, ux, perf])
    const elevatedDesigner = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.nodeId, 'designer'), eq(nodeRuns.status, 'pending')))
    expect(elevatedDesigner.length).toBe(1)

    // RFC-132: "consumed" = dispatched_at stamped on every round's designer entry (the
    // unified stamp; designerRunTriggeredAt is legacy bookkeeping, no longer written).
    const designerEntries = (
      await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    ).filter((e) => e.roleKind === 'designer')
    expect(designerEntries.length).toBe(3)
    for (const e of designerEntries) {
      expect(e.dispatchedAt).not.toBeNull()
    }
  })
})
