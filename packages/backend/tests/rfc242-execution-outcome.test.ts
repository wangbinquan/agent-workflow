// RFC-242 T4 — unified outcome projection matrix.
//
// Locks in (design.md §1.3/§6.4):
//   1. Row selection is the pickUpstreamSourceRun口径 (top-level + done +
//      highest iteration + ULID freshness) — review/loop multi-generation rows
//      and fanout child rows can never leak into the projection.
//   2. Non-done tasks project empty outputs; the tasks-row error triple is
//      passed through verbatim (summary=human, message=machine code).
//   3. Workgroup result carriers: explicit anchor body first; lw falls back to
//      gate_summary; fc without an anchor degrades to '' + warning (RFC-184:
//      wg_* ports are never persisted); dynamic_workflow in phase 'executing'
//      projects exactly like a workflow task.
//   4. Cross-output-node port collisions are deterministic (node-id order,
//      later wins) and surfaced as warnings.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  getExecutionOutcome,
  projectExecutionOutcome,
  type OutcomeRunRow,
  type OutcomeTaskRow,
} from '../src/services/execution/outcome'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function baseTask(overrides: Partial<OutcomeTaskRow> = {}): OutcomeTaskRow {
  return {
    id: 't1',
    status: 'done',
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    workflowSnapshot: JSON.stringify({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'work', kind: 'agent-single' },
        { id: 'out-a', kind: 'output' },
      ],
      edges: [],
    }),
    ...overrides,
  }
}

function run(over: Partial<OutcomeRunRow> & { id: string; nodeId: string }): OutcomeRunRow {
  return { iteration: 0, parentNodeRunId: null, status: 'done', ...over }
}

describe('RFC-242 T4 — workflow projection (pickUpstreamSourceRun口径)', () => {
  test('picks the highest iteration, then the freshest ULID; fanout child rows excluded', () => {
    const old = run({ id: '01A', nodeId: 'out-a' })
    const newer = run({ id: '01B', nodeId: 'out-a', iteration: 1 })
    const newest = run({ id: '01C', nodeId: 'out-a', iteration: 1 })
    const shard = run({ id: '01D', nodeId: 'out-a', iteration: 1, parentNodeRunId: '01C' })
    const outcome = projectExecutionOutcome({
      task: baseTask(),
      runs: [old, newer, newest, shard],
      outputs: [
        { nodeRunId: '01A', portName: 'report', content: 'old', kind: 'text' },
        { nodeRunId: '01B', portName: 'report', content: 'superseded', kind: 'text' },
        { nodeRunId: '01C', portName: 'report', content: 'current', kind: 'text' },
        { nodeRunId: '01D', portName: 'report', content: 'shard-leak', kind: 'text' },
      ],
      workgroup: null,
    })
    expect(outcome.outputs).toEqual({ report: { content: 'current', kind: 'text' } })
    expect(outcome.warnings).toEqual([])
  })

  test('non-done rows never win even when fresher', () => {
    const done = run({ id: '01A', nodeId: 'out-a' })
    const failedFresher = run({ id: '01Z', nodeId: 'out-a', status: 'failed' })
    const outcome = projectExecutionOutcome({
      task: baseTask(),
      runs: [done, failedFresher],
      outputs: [{ nodeRunId: '01A', portName: 'report', content: 'ok', kind: null }],
      workgroup: null,
    })
    expect(outcome.outputs.report?.content).toBe('ok')
  })

  test('cross-output-node port collision: node-id order, later wins, warning surfaced', () => {
    const task = baseTask({
      workflowSnapshot: JSON.stringify({
        nodes: [
          { id: 'out-b', kind: 'output' },
          { id: 'out-a', kind: 'output' },
        ],
      }),
    })
    const outcome = projectExecutionOutcome({
      task,
      runs: [run({ id: '01A', nodeId: 'out-a' }), run({ id: '01B', nodeId: 'out-b' })],
      outputs: [
        { nodeRunId: '01A', portName: 'x', content: 'from-a', kind: null },
        { nodeRunId: '01B', portName: 'x', content: 'from-b', kind: null },
      ],
      workgroup: null,
    })
    // sorted node ids: out-a then out-b → out-b (later) wins
    expect(outcome.outputs.x?.content).toBe('from-b')
    expect(outcome.warnings).toContain('output-port-collision:x')
  })

  test('non-done task: empty outputs + verbatim error triple', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({
        status: 'failed',
        errorSummary: 'workgroup hit max_rounds (3)',
        errorMessage: 'max-rounds',
        failedNodeId: null,
      }),
      runs: [],
      outputs: [],
      workgroup: null,
    })
    expect(outcome.terminal).toBe(true)
    expect(outcome.outputs).toEqual({})
    expect(outcome.error).toEqual({
      summary: 'workgroup hit max_rounds (3)',
      message: 'max-rounds',
      failedNodeId: null,
    })
  })

  test('unparsable snapshot degrades to warning, not throw', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workflowSnapshot: 'not json' }),
      runs: [],
      outputs: [],
      workgroup: null,
    })
    expect(outcome.outputs).toEqual({})
    expect(outcome.warnings).toContain('workflow-snapshot-unparsable')
  })
})

describe('RFC-242 T4 — agent projection', () => {
  test('projects the __agent_main__ ports', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ sourceAgentName: 'worker', workflowSnapshot: '{"nodes":[]}' }),
      runs: [run({ id: '01A', nodeId: '__agent_main__' })],
      outputs: [{ nodeRunId: '01A', portName: 'out', content: 'payload', kind: 'text' }],
      workgroup: null,
    })
    expect(outcome.outputs).toEqual({ out: { content: 'payload', kind: 'text' } })
  })
})

describe('RFC-242 T4/§6.4 — workgroup result carriers', () => {
  const lw = JSON.stringify({ mode: 'leader_worker' })
  const fc = JSON.stringify({ mode: 'free_collab' })
  const dw = JSON.stringify({ mode: 'dynamic_workflow' })

  test('explicit anchor body wins for both turn-engine modes', () => {
    for (const config of [lw, fc]) {
      const outcome = projectExecutionOutcome({
        task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: config }),
        runs: [],
        outputs: [],
        workgroup: { gateSummary: 'gate says', dwPhase: null, resultMessageBody: 'anchored' },
      })
      expect(outcome.outputs).toEqual({ result: { content: 'anchored', kind: 'text' } })
    }
  })

  test('lw falls back to gate_summary for legacy tasks', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: lw }),
      runs: [],
      outputs: [],
      workgroup: { gateSummary: 'shipped the fix', dwPhase: null, resultMessageBody: null },
    })
    expect(outcome.outputs).toEqual({ result: { content: 'shipped the fix', kind: 'text' } })
    expect(outcome.warnings).toEqual([])
  })

  test('fc without an anchor degrades to empty result + warning (RFC-184: no persisted ports)', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: fc }),
      runs: [],
      outputs: [],
      workgroup: { gateSummary: 'free-collab converged', dwPhase: null, resultMessageBody: null },
    })
    expect(outcome.outputs).toEqual({ result: { content: '', kind: 'text' } })
    expect(outcome.warnings).toContain('workgroup-result-anchor-missing')
  })

  test('dynamic_workflow executing projects like a workflow task', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: dw }),
      runs: [run({ id: '01A', nodeId: 'out-a' })],
      outputs: [{ nodeRunId: '01A', portName: 'plan', content: 'dag says', kind: 'text' }],
      workgroup: { gateSummary: null, dwPhase: 'executing', resultMessageBody: null },
    })
    expect(outcome.outputs).toEqual({ plan: { content: 'dag says', kind: 'text' } })
  })

  test('dynamic_workflow outside executing warns instead of fabricating a result', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: dw }),
      runs: [],
      outputs: [],
      workgroup: { gateSummary: null, dwPhase: 'generating', resultMessageBody: null },
    })
    expect(outcome.outputs).toEqual({})
    expect(outcome.warnings).toContain('workgroup-dw-not-executing')
  })

  test('unparsable workgroup config warns', () => {
    const outcome = projectExecutionOutcome({
      task: baseTask({ workgroupId: 'wg1', workgroupConfigJson: 'not json' }),
      runs: [],
      outputs: [],
      workgroup: { gateSummary: null, dwPhase: null, resultMessageBody: null },
    })
    expect(outcome.warnings).toContain('workgroup-config-unparsable')
  })
})

describe('RFC-242 T4 — getExecutionOutcome db assembly', () => {
  test('done workflow task round-trips output rows; missing task 404s', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'out-a', kind: 'output', ports: [] }],
      edges: [],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: `wf-${workflowId.slice(-6).toLowerCase()}`,
      definition: JSON.stringify(definition),
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc242-outcome',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/rfc242-nowhere',
      worktreePath: '/tmp/rfc242-nowhere',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'out-a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: runId,
      portName: 'report',
      content: 'hello',
      kind: 'text',
    })
    const outcome = await getExecutionOutcome(db, taskId)
    expect(outcome.status).toBe('done')
    expect(outcome.outputs).toEqual({ report: { content: 'hello', kind: 'text' } })

    await expect(getExecutionOutcome(db, ulid())).rejects.toMatchObject({
      code: 'task-not-found',
    })
  })
})
