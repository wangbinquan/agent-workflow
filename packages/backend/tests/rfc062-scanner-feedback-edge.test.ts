// RFC-062 PR-A T3 — scanFreshDownstream must not gate on feedback edges.
//
// Pre-RFC-062 (commit f206459 hard cut), scanFreshDownstream gated on
// every inbound edge, including target-port-is-__clarify_response__ /
// __external_feedback__. Result: every workflow containing
// self-clarify or cross-clarify deadlocked the moment the input node
// completed — the downstream agent's gating row was waiting for
// `done` on clarify_xxx / cross_clarify_xxx logical_runs which never
// arrive because those nodes only mint a run AFTER the agent itself
// suspends with the corresponding signal (the chicken-and-egg / back-
// edge problem).
//
// The 2026-05-25 incident task 01KSE07E4D6TDHMAS1VZWVMKE7 stopped at
// event 4 (logical-run-completed:in_0ck111); agent_m7p3n1 was never
// minted. The fix: scanFreshDownstream calls filterDataEdges(edges)
// before building the upstreamMap, so feedback edges no longer
// participate in the gating. This file pins the fix.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { logicalRuns, tasks, workflows } from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { scanFreshDownstream } from '../src/scheduler-v2/readyScanner'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({ id: 'wf1', name: 'wf-test', schemaVersion: 4, definition: '{}' })
    .run()
  db.insert(tasks)
    .values({
      id: 't1',
      name: 'rfc062-scanner-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-rfc062/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  return db
}

function agentNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName: 'doc',
    promptTemplate: '',
  } as unknown as WorkflowNode
}

function inputNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'input',
    position: { x: 0, y: 0 },
    inputKey: 'requirement',
  } as unknown as WorkflowNode
}

function clarifyNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'clarify',
    position: { x: 0, y: 0 },
  } as unknown as WorkflowNode
}

function crossClarifyNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'clarify-cross-agent',
    position: { x: 0, y: 0 },
  } as unknown as WorkflowNode
}

/**
 * Mark `in_0ck111` as done by writing its 4-event sequence (matches
 * the incident task's actual event log).
 */
async function completeInput(db: DbClient): Promise<void> {
  await writeEvents(db, [
    {
      taskId: 't1',
      kind: 'logical-run-created',
      nodeId: 'in_0ck111',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      actor: 'system',
      payload: {},
    },
    {
      taskId: 't1',
      kind: 'attempt-output-captured',
      nodeId: 'in_0ck111',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      actor: 'system',
      payload: { portName: 'requirement', content: '生成贪吃蛇游戏设计' },
    },
    {
      taskId: 't1',
      kind: 'logical-run-completed',
      nodeId: 'in_0ck111',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      actor: 'system',
      payload: {},
    },
  ])
}

describe('scanFreshDownstream — feedback edges must not gate', () => {
  test('REGRESSION (2026-05-25 incident): cross-clarify workflow, input done → downstream agent ready', async () => {
    const db = setupDb()
    await completeInput(db)
    // Workflow shape from the actual incident task workflow snapshot
    // (subset focused on agent_m7p3n1's inbound edges). The 3 inbound
    // edges are exactly:
    //   in_0ck111.requirement → agent_m7p3n1.requirement       (data)
    //   cross_clarify_6c910f.to_designer → .__external_feedback__ (feedback)
    //   clarify_400qzp.answers → .__clarify_response__          (feedback)
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        inputNode('in_0ck111'),
        agentNode('agent_m7p3n1'),
        clarifyNode('clarify_400qzp'),
        crossClarifyNode('cross_clarify_6c910f'),
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_0ck111', portName: 'requirement' },
          target: { nodeId: 'agent_m7p3n1', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'cross_clarify_6c910f', portName: 'to_designer' },
          target: { nodeId: 'agent_m7p3n1', portName: '__external_feedback__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clarify_400qzp', portName: 'answers' },
          target: { nodeId: 'agent_m7p3n1', portName: '__clarify_response__' },
        },
      ],
    } as unknown as WorkflowDefinition

    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })

    // The fix: agent_m7p3n1 should now be ready (data edge from in_0ck111
    // is satisfied; feedback edges from clarify_xxx / cross_clarify_xxx
    // are not gates).
    expect(ready.length).toBe(1)
    expect(ready[0]!.scope).toEqual({
      nodeId: 'agent_m7p3n1',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
  })

  test('inbound only __clarify_response__ (feedback only) → still ready (no data gate at all)', async () => {
    const db = setupDb()
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [agentNode('agent_x'), clarifyNode('clarify_y')],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'clarify_y', portName: 'answers' },
          target: { nodeId: 'agent_x', portName: '__clarify_response__' },
        },
      ],
    } as unknown as WorkflowDefinition

    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })
    // After filterDataEdges, agent_x has 0 inbound — treated as an
    // entry node + seeded by launcher, so the lazy-cascade scanner
    // correctly returns 0 (entry nodes are NOT scanFreshDownstream's
    // job; they come in via launcher's seedInitialEventsIfMissing).
    expect(ready.length).toBe(0)
  })

  test('inbound only __external_feedback__ + unsatisfied data edge → still NOT ready', async () => {
    const db = setupDb()
    // Same shape as above but with a pending data edge that has no done upstream.
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [inputNode('in_pending'), agentNode('agent_x'), crossClarifyNode('cross_y')],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_pending', portName: 'requirement' },
          target: { nodeId: 'agent_x', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'cross_y', portName: 'to_designer' },
          target: { nodeId: 'agent_x', portName: '__external_feedback__' },
        },
      ],
    } as unknown as WorkflowDefinition

    // No `done` row for in_pending yet → agent_x not ready (data edge
    // gate intact; feedback edge correctly ignored either way).
    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })
    expect(ready.length).toBe(0)
  })

  test('mixed feedback + data edges → only data edges gate', async () => {
    const db = setupDb()
    await completeInput(db)
    // agent_x has 1 data edge (from in_0ck111, satisfied) + 1 feedback
    // edge (from cross_y, NOT done) — should still be ready after the fix.
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [inputNode('in_0ck111'), agentNode('agent_x'), crossClarifyNode('cross_y')],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_0ck111', portName: 'requirement' },
          target: { nodeId: 'agent_x', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'cross_y', portName: 'to_designer' },
          target: { nodeId: 'agent_x', portName: '__external_feedback__' },
        },
      ],
    } as unknown as WorkflowDefinition

    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })
    expect(ready.length).toBe(1)
    expect(ready[0]!.scope.nodeId).toBe('agent_x')
  })

  test('pure data linear chain: input.done → agent ready (no feedback edges at all)', async () => {
    const db = setupDb()
    await completeInput(db)
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [inputNode('in_0ck111'), agentNode('agent_x')],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_0ck111', portName: 'requirement' },
          target: { nodeId: 'agent_x', portName: 'requirement' },
        },
      ],
    } as unknown as WorkflowDefinition

    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })
    expect(ready.length).toBe(1)
    expect(ready[0]!.scope.nodeId).toBe('agent_x')
  })

  test('empty edges array → no readiness change (no panic)', async () => {
    const db = setupDb()
    const workflow: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [agentNode('a')],
      edges: [],
    } as unknown as WorkflowDefinition
    const ready = scanFreshDownstream({ db, taskId: 't1', workflow })
    expect(ready.length).toBe(0)
    // Sanity: logicalRuns is still empty (we didn't accidentally mint anything).
    expect(db.select().from(logicalRuns).all().length).toBe(0)
  })
})
