// Locks in: listClarifySummaries surfaces each session's source-agent
// node display name (the new WorkflowNode.title field) so the inbox can
// render "节点名" rather than the opaque `sourceAgentNodeId`. Three
// scenarios cover the matrix the frontend depends on:
//   1. Snapshot has `title: 'Coder'` on the source agent → title surfaces.
//   2. Snapshot has no title (legacy node) → field is null, frontend
//      falls back to sourceAgentNodeId.
//   3. Snapshot JSON is corrupt → field is null (no throw).
//
// Mirrors the equivalent enrichment review summaries already do for
// review nodes (see services/review.ts listReviewSummaries).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { insertLegacySelfClarify } from './clarify-fixtures'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { listClarifySummaries } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildDef(agentNode: WorkflowNode): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [agentNode, { id: 'clarify1', kind: 'clarify' } as WorkflowNode],
    edges: [
      {
        id: 'e1',
        source: { nodeId: agentNode.id, portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: agentNode.id, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedSessionForSnapshot(
  db: DbClient,
  snapshotJson: string,
  agentNodeId: string,
): Promise<{ taskId: string; sessionId: string }> {
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
    repoPath: '/tmp/aw-clarify-title-test/repo',
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
    nodeId: 'clarify1',
    status: 'awaiting_human',
    retryIndex: 0,
    iteration: 0,
  })
  const sessionId = `cs_${taskId}`
  await insertLegacySelfClarify(db, {
    id: sessionId,
    taskId,
    sourceAgentNodeId: agentNodeId,
    sourceAgentNodeRunId: 'nr_src',
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    clarifyNodeRunId,
    iterationIndex: 0,
    status: 'awaiting_human',
    questionsJson: '[]',
    createdAt: Date.now(),
  })
  return { taskId, sessionId }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('listClarifySummaries — sourceAgentNodeTitle enrichment', () => {
  test('surfaces the agent node title from the workflow snapshot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'agent_coder_01',
      kind: 'agent-single',
      agentName: 'coder',
      title: 'Implementation Coder',
    } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'agent_coder_01')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row).toBeDefined()
    expect(row?.sourceAgentNodeId).toBe('agent_coder_01')
    expect(row?.sourceAgentNodeTitle).toBe('Implementation Coder')
  })

  test('returns null when the agent node has no title set', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'agent_designer_07',
      kind: 'agent-single',
      agentName: 'designer',
    } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'agent_designer_07')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.sourceAgentNodeTitle).toBeNull()
    expect(row?.sourceAgentNodeId).toBe('agent_designer_07')
  })

  test('returns null when the title is an empty / whitespace-only string', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = buildDef({
      id: 'agent_writer_03',
      kind: 'agent-single',
      agentName: 'writer',
      title: '   ',
    } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'agent_writer_03')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.sourceAgentNodeTitle).toBeNull()
  })

  test('returns null when the workflow snapshot is corrupt (no throw)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedSessionForSnapshot(db, '{not valid json', 'agent_ghost')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.sourceAgentNodeTitle).toBeNull()
    expect(row?.sourceAgentNodeId).toBe('agent_ghost')
  })

  test('returns null when the snapshot does not contain the source agent node id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // The session points at agent_typo_99 but the snapshot only knows about
    // agent_coder_01 — simulates a snapshot rewrite that orphaned a session.
    const def = buildDef({
      id: 'agent_coder_01',
      kind: 'agent-single',
      agentName: 'coder',
      title: 'Coder',
    } as WorkflowNode)
    const { taskId } = await seedSessionForSnapshot(db, JSON.stringify(def), 'agent_typo_99')

    const out = await listClarifySummaries(db)
    const row = out.find((r) => r.taskId === taskId)
    expect(row?.sourceAgentNodeTitle).toBeNull()
    expect(row?.sourceAgentNodeId).toBe('agent_typo_99')
  })
})
