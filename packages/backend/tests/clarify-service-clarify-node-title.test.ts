// Locks in RFC-037 follow-up: clarify list + detail surface the user-set
// `WorkflowNode.title` for the *clarify* node itself (parallel to the
// existing `sourceAgentNodeTitle` enrichment), so the frontend can render
// "任务名 / 节点标题" exactly the way the review side already does.
//
// Three scenarios — same matrix the sourceAgentNodeTitle test uses:
//   1. Snapshot has `title: 'Ask user about the DB'` on the clarify node
//      → both listClarifySummaries and getClarifyDetail surface it.
//   2. Snapshot has no title (legacy node) → field is null and the frontend
//      falls back to clarifyNodeId.
//   3. Snapshot JSON is corrupt → field is null (no throw).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { getClarifyDetail, listClarifySummaries } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildDef(clarifyNode: WorkflowNode): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'agent_coder_01', kind: 'agent-single', agentName: 'coder' } as WorkflowNode,
      clarifyNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'agent_coder_01', portName: '__clarify__' },
        target: { nodeId: clarifyNode.id, portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: clarifyNode.id, portName: 'answers' },
        target: { nodeId: 'agent_coder_01', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedSessionForSnapshot(
  db: DbClient,
  snapshotJson: string,
  clarifyNodeId: string,
): Promise<{ taskId: string; clarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: snapshotJson,
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshotJson,
    repoPath: '/tmp/aw-clarify-node-title-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  const clarifyNodeRunId = `nr_clarify_${taskId}`
  await db.insert(nodeRuns).values({
    id: clarifyNodeRunId,
    taskId,
    nodeId: clarifyNodeId,
    status: 'awaiting_human',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
  })
  const sessionId = `cs_${taskId}`
  await db.insert(clarifySessions).values({
    id: sessionId,
    taskId,
    sourceAgentNodeId: 'agent_coder_01',
    sourceAgentNodeRunId: 'nr_src',
    sourceShardKey: null,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex: 0,
    status: 'awaiting_human',
    questionsJson: '[]',
    createdAt: Date.now(),
  })
  return { taskId, clarifyNodeRunId }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('clarify summary + detail — clarifyNodeTitle enrichment', () => {
  test('list surfaces clarify node title from the workflow snapshot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'clarify_db',
      kind: 'clarify',
      title: 'Ask user about the DB',
    } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'clarify_db')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row).toBeDefined()
    expect(row?.clarifyNodeId).toBe('clarify_db')
    expect(row?.clarifyNodeTitle).toBe('Ask user about the DB')
  })

  test('detail surfaces clarify node title from the workflow snapshot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'clarify_db',
      kind: 'clarify',
      title: 'Ask user about the DB',
    } as WorkflowNode)
    const { clarifyNodeRunId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'clarify_db')
    const session = await getClarifyDetail(db, clarifyNodeRunId)
    expect(session.clarifyNodeId).toBe('clarify_db')
    expect(session.clarifyNodeTitle).toBe('Ask user about the DB')
  })

  test('list returns null clarifyNodeTitle when the clarify node has no title set', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({ id: 'clarify_legacy', kind: 'clarify' } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'clarify_legacy')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.clarifyNodeTitle).toBeNull()
    expect(row?.clarifyNodeId).toBe('clarify_legacy')
  })

  test('detail returns null clarifyNodeTitle for whitespace-only title (no false-positive)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'clarify_blank',
      kind: 'clarify',
      title: '   ',
    } as WorkflowNode)
    const { clarifyNodeRunId } = await seedSessionForSnapshot(
      db,
      JSON.stringify(def),
      'clarify_blank',
    )
    const session = await getClarifyDetail(db, clarifyNodeRunId)
    expect(session.clarifyNodeTitle).toBeNull()
  })

  test('list returns null clarifyNodeTitle when the workflow snapshot is corrupt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedSessionForSnapshot(db, '{not valid json', 'clarify_ghost')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.clarifyNodeTitle).toBeNull()
    expect(row?.clarifyNodeId).toBe('clarify_ghost')
  })
})
