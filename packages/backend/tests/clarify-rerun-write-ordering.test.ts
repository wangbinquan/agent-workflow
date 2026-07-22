// RFC-076 PR-0 (T0) — clarify rerun continuation, torn-read safety (functional lock).
//
// WHY THIS FILE EXISTS (regression intent):
//   Answering a self-clarify writes TWO node_runs facts for one logical event:
//   the source-agent rerun `pending` mint and the clarify node_run flip
//   awaiting_human→done. A reader landing between them must never observe
//   "clarify done, rerun absent": a dispatch frontier derived from node_runs at
//   that instant would judge the agent's prior done row still freshest ⇒ scope
//   allSettled ⇒ FALSE COMPLETION, silently dropping the rerun.
//
//   History: the legacy quick-channel finalize closed this window by lexical
//   write ordering (rerun insert BEFORE the session/round flip), and this file
//   carried a source-ordering grep guard on that function's internals. RFC-132
//   replaced the quick channel with the unified seal + auto-dispatch
//   (autoDispatchClarifyRound): sealRoundQuestions commits the round answered
//   with the entries SEALED-UNDISPATCHED — a state that PARKS the home node
//   (never a completing frontier) until dispatchTaskQuestions mints the rerun.
//   The T0 torn-window protection is therefore the park-pinning invariant,
//   locked by rfc128-p5-0-stranding-guard.test.ts and the park tests in
//   rfc128-p5-d-autodispatch.test.ts; the lexical source-ordering guard was
//   superseded and removed with the dead function. The functional happy-path
//   lock below stays: answering a self-clarify still yields exactly one pending
//   rerun + a done clarify row.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
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

function selfClarifyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'agent_x', kind: 'agent-single', agentName: 'agent_x' },
      { id: 'clarify_x', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'e_in_x',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'agent_x', portName: 'requirement' },
      },
      {
        id: 'e_x_clarify',
        source: { nodeId: 'agent_x', portName: '__clarify__' },
        target: { nodeId: 'clarify_x', portName: 'questions' },
      },
      {
        id: 'e_clarify_x',
        source: { nodeId: 'clarify_x', portName: 'answers' },
        target: { nodeId: 'agent_x', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'fixture',
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
    repoPath: '/tmp/aw-t0-ordering',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-076 PR-0 — clarify rerun write-ordering', () => {
  test('functional: answering a self-clarify yields exactly one pending rerun + a done clarify row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, selfClarifyDef())

    // Source agent run (done, with a pre-snapshot to also exercise the rollback path —
    // worktreePath '' makes rollback a no-op, keeping the test hermetic).
    const agentRunId = `nr_agent_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(nodeRuns).values({
      id: agentRunId,
      taskId,
      nodeId: 'agent_x',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      preSnapshot: 'snap-x',
    })

    const sess = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'agent_x',
      askingNodeRunId: agentRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify_x',
      iteration: 0,
      questions: [makeQ('q1')],
      truncationWarnings: [],
    })

    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
      actor: { userId: 'u1', role: 'owner' },
    })

    // Clarify node row is done.
    const clarifyRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, sess.intermediaryNodeRunId)).limit(1)
    )[0]
    expect(clarifyRow?.status).toBe('done')

    // Exactly one fresh pending rerun on the source agent.
    const agentRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'agent_x')))
    const pending = agentRows.filter((r) => r.status === 'pending')
    expect(pending.length).toBe(1)
    expect(pending[0]!.iteration).toBe(0)
    // The prior done row is left untouched as history.
    expect(agentRows.find((r) => r.id === agentRunId)?.status).toBe('done')
  })
})
