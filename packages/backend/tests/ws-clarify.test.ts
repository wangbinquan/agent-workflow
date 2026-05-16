// RFC-023 PR-B T14 — verifies clarify.* events flow through the WS
// broadcaster on the /ws/tasks/{taskId} channel.
//
// The WS server itself just forwards every message dispatched to the
// channel, so this test pins the contract at the broadcaster boundary:
//   - createClarifySession dispatches a `clarify.created` event whose
//     payload includes sourceShardKey + iterationIndex + a compact summary.
//   - submitClarifyAnswers dispatches a `clarify.answered` event whose
//     payload includes the rerunNodeRunId so subscribers can switch focus.
//
// If the WS endpoint regresses, the broader integration tests (and the
// frontend's useClarifyWs hook tests landing in PR-C) catch that — here
// we lock the payload shape end-to-end through the runtime path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import type { TaskWsMessage, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const QUESTION = {
  id: 'q1',
  title: 'Pick?',
  kind: 'single' as const,
  recommended: false,
  options: ['A', 'B'],
}

async function seedTask(db: DbClient): Promise<{ taskId: string; sourceRunId: string }> {
  const taskId = `task_${ulid()}`
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as any,
      { id: 'c1', kind: 'clarify', title: 'Clarify' } as any,
    ],
    edges: [],
    outputs: [],
  }
  const wfId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify(def),
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-ws/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
  })
  return { taskId, sourceRunId }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

describe('clarify.* events broadcast on TASK_CHANNEL (RFC-023 T14)', () => {
  test('createClarifySession dispatches clarify.created with sourceShardKey + iterationIndex + session summary', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, sourceRunId } = await seedTask(db)

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: 'shard-A',
      clarifyNodeId: 'c1',
      iterationIndex: 0,
      questions: [QUESTION],
    })

    const created = received.find((m) => m.type === 'clarify.created')
    expect(created).toBeDefined()
    if (created?.type !== 'clarify.created') throw new Error('type narrowing')
    expect(created.clarifyNodeId).toBe('c1')
    expect(created.sourceShardKey).toBe('shard-A')
    expect(created.iterationIndex).toBe(0)
    expect(created.session.questionCount).toBe(1)
    expect(created.session.status).toBe('awaiting_human')
  })

  test('submitClarifyAnswers dispatches clarify.answered with rerunNodeRunId so subscribers can refocus', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, sourceRunId } = await seedTask(db)
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'c1',
      iterationIndex: 0,
      questions: [QUESTION],
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    })
    const answered = received.find((m) => m.type === 'clarify.answered')
    expect(answered).toBeDefined()
    if (answered?.type !== 'clarify.answered') throw new Error('type narrowing')
    expect(answered.rerunNodeRunId).toBe(rerunNodeRunId)
    expect(answered.iterationIndex).toBe(0)
    expect(answered.session.status).toBe('answered')
    expect(answered.session.answers?.[0]?.selectedOptionLabels).toEqual(['A'])
  })
})
