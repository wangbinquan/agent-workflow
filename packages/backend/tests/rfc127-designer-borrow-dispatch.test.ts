// RFC-127 T5 / RFC-131 T4 «借壳» (borrow-the-shell) — RETIRED by RFC-162.
//
// This file WAS the positive lock for the RFC-127「借壳」→ RFC-131 T4「去借壳」dispatch path (reassign
// an OVERRIDE target → the designer rerun MOVES to that node running its OWN agent, agent_override_name
// NULL). RFC-162 归一 deletes the last input that path relied on: a clarify reassign no longer sets
// `overrideTargetNodeId` at all — it ADDS a `roleKind='designer'` handler row with `defaultTargetNodeId`
// (override stays NULL), so `resolveBorrowForNode` can never observe an override for a clarify entry.
// Borrow is therefore structurally impossible via the reassign path (the mechanism itself was already
// de-borrowed by RFC-131 T4).
//
// RETIRED cases (all were override-driven, via reassignTaskQuestion on a clarify entry):
//   • 「去借壳 mint: override X → mint node_id=X + agent_override_name NULL」
//   • 「never-run reassign target → task-question-unsafe-dispatch-target」
//   • the two no-override golden-locks (mint D / scheduler spawns the home agent).
// Their LIVE RFC-162 equivalents (mint node_id = effective target OTHER, agent_override_name NULL,
// never-run target → task-question-unsafe-dispatch-target, home runs its own agent) now live in
// rfc120-deferred-dispatch.test.ts. The pure-borrow feature tests (per-home multi-borrow, cascade
// propagation, carry-leak, retry-keeps-borrow) were already deleted by RFC-131 T4.
//
// What remains is ONE structural lock: a clarify reassign produces a designer handler with NO
// override — so a refactor that re-introduces borrow through the reassign path goes red here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { reassignTaskQuestion } from '../src/services/taskQuestions'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node (no __external_feedback__ edge) — a valid UPSTREAM reassign target.
const OTHER = 'other'
const OTHER_AGENT = 'other'

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
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

/** Seed a task on liveDef + the designer's prior `done` draft + the questioner's `done` asking run,
 *  then open one cross-clarify session (awaiting_human). */
async function seedTask(db: DbClient): Promise<{ taskId: string; crossClarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc127-retired',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc127-retired',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc127/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: CC,
    askingNodeId: QUESTIONER,
    askingNodeRunId: questionerRunId,
    targetConsumerNodeId: DESIGNER,
    loopIter: 0,
    questions: [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, crossClarifyNodeRunId }
}

async function designerEntries(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-162 — 借壳 (borrow) retired: a clarify reassign sets NO override', () => {
  test('reassign the asker UPSTREAM → designer handler with default=target, overrideTargetNodeId NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db)
    // Control-channel seal → answered round + ONE questioner entry (RFC-162: no designer by default).
    await sealRoundQuestions({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const questioner = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'questioner')))
    )[0]!
    // Reassign the asker upstream to a DIFFERENT agent node → ADDS a designer handler on it.
    const action = await reassignTaskQuestion(db, questioner.id, OTHER, actor)
    expect(action).toBe('added-designer')
    const designer = (await designerEntries(db, taskId))[0]!
    expect(designer.defaultTargetNodeId).toBe(OTHER)
    // 借壳 dead: the reassign records the target as the handler's DEFAULT, never as an override —
    // so resolveBorrowForNode can never see an override and no agent is ever borrowed.
    expect(designer.overrideTargetNodeId).toBeNull()
  })
})
