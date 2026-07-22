// RFC-059 C4 (slimmed by RFC-132, migrated by RFC-162) — a RESOLVED sibling that
// produced no designer entry must not block (or feed) the designer.
//
// The original file locked the RFC-059 "fast path" (the retired legacy immediate
// questioner mint) around per-question SCOPE. RFC-132 unified all answers onto
// autoDispatchClarifyRound; RFC-162 then DELETED per-question scope + designer-by-default
// entirely — a cross answer yields exactly one questioner card, and a designer handler
// row is created only by an explicit human reassign. The ONE invariant that survives here
// (multi-source readiness with a mixed-reassign sibling set):
//
//   Peer A answers its round but is left as a questioner-only continuation (never
//   reassigned to the designer). Peer B (same designer) answers AND is reassigned to the
//   designer. The designer readiness must treat A as RESOLVED (answered, nothing to feed) —
//   B's dispatch alone fires exactly one designer rerun; A contributes no designer entry
//   to the batch.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createClarifyRound } from '../src/services/clarify/service'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: a designer handler is created by an explicit reassign of the answered round's
// questioner card to the graph designer node, then dispatched to mint the designer rerun.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunId: string,
) {
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${crossClarifyNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${crossClarifyNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], actor)
}

async function seedTwoSource(db: DbClient): Promise<{ taskId: string; def: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
    { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  const edges: WorkflowDefinition['edges'] = []
  for (const pair of [
    { q: 'q_a', cc: 'cc_a' },
    { q: 'q_b', cc: 'cc_b' },
  ]) {
    edges.push({
      id: `e_q_${pair.cc}`,
      source: { nodeId: pair.q, portName: '__clarify__' },
      target: { nodeId: pair.cc, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_questioner' },
      target: { nodeId: pair.q, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc-059-c4',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc-059-c4',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059-c4/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: 'nr_d_1',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  return { taskId, def }
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

async function spawnSession(
  db: DbClient,
  taskId: string,
  args: {
    questionerNodeId: string
    questionerRunId: string
    ccNodeId: string
    questions: ClarifyQuestion[]
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId,
    nodeId: args.questionerNodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: args.ccNodeId,
    askingNodeId: args.questionerNodeId,
    askingNodeRunId: args.questionerRunId,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  return crossClarifyNodeRunId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 C4 — questioner-scope sibling resolution unblocks the designer', () => {
  test('peer A questioner-only + B reassigned-to-designer → the designer rerun fires from B alone', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    // Peer A answers and is left as a questioner-only continuation (RFC-162: NOT reassigned to
    // the designer → NO designer entry). The designer must NOT rerun on A's answer.
    const aResult = await autoDispatchClarifyRound({
      db,
      originNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      actor,
    })
    expect(aResult.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const aEntries = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, aRunId))
    expect(aEntries.some((e) => e.roleKind === 'designer')).toBe(false)
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))).length).toBe(1)

    // Peer B answers, then is reassigned to the designer + dispatched. A reads as RESOLVED
    // (answered) in the readiness scan, so B's dispatch alone fires the designer — exactly one
    // rerun, carrying only B's designer entry (A never produced one).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: bRunId,
      answers: [
        { questionId: 'b1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      actor,
    })
    const bDisp = await reassignThenDispatchDesigner(db, taskId, bRunId)
    const designerRerun = bDisp.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    expect(designerRerun!.entryIds).toHaveLength(1)
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(2) // initial done + new rerun
  })
})
