// RFC-243 T4 — unified outcome projection matrix.
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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import {
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
  workgroupMessages,
  workgroupTaskState,
} from '../src/db/schema'
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

describe('RFC-243 T4 — workflow projection (pickUpstreamSourceRun口径)', () => {
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

describe('RFC-243 T4 — agent projection', () => {
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

describe('RFC-243 T4/§6.4 — workgroup result carriers', () => {
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

describe('RFC-243 §6.4 — workgroup result anchor db assembly (PR-4)', () => {
  test('result_message_id anchors the projection; noise decision rows cannot win', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'wf-wg', definition: '{}' })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'wg-anchor',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/x',
      worktreePath: '/x',
      baseBranch: 'main',
      branch: `b-${taskId.slice(-4)}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      workgroupId: ulid(),
      workgroupConfigJson: JSON.stringify({ mode: 'free_collab' }),
    })
    const anchorId = ulid()
    // 先插一条同 kind 同 author 的噪声行（zero-delta 告警形态），再插真结果 ——
    // 锚必须精确指到真结果，任何 kind/author 启发式都会取错。
    await db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: 1,
      authorKind: 'system',
      kind: 'decision',
      bodyMd: '⚠️ zero-delta warning noise',
      createdAt: Date.now(),
    })
    await db.insert(workgroupMessages).values({
      id: anchorId,
      taskId,
      round: 1,
      authorKind: 'system',
      kind: 'decision',
      bodyMd: 'free-collab converged — 2 task(s) done',
      createdAt: Date.now() + 1,
    })
    await db.insert(workgroupTaskState).values({
      taskId,
      gateStatus: 'idle',
      resultMessageId: anchorId,
      updatedAt: Date.now(),
    })
    const outcome = await getExecutionOutcome(db, taskId)
    expect(outcome.outputs).toEqual({
      result: { content: 'free-collab converged — 2 task(s) done', kind: 'text' },
    })
    expect(outcome.warnings).toEqual([])
  })
})

describe('RFC-243 §6.3 — dw 子任务的 result 折叠（实现门 P1-3）', () => {
  test('多端口按 name 字典序折叠成单一 result；已有 result 端口原样保留', async () => {
    // 折叠发生在调度器 F 步（call-workgroup 臂）；这里锁定其纯函数形态：
    // 投影产出多端口 → 折叠为 `## name` 分节，顺序与端口名字典序一致。
    const collapse = (outputs: Record<string, { content: string; kind: string | null }>) =>
      Object.hasOwn(outputs, 'result')
        ? { result: outputs.result! }
        : {
            result: {
              content: Object.entries(outputs)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, v]) => `## ${name}\n${v.content}`)
                .join('\n\n'),
              kind: 'text',
            },
          }
    expect(
      collapse({
        zeta: { content: 'Z', kind: 'text' },
        alpha: { content: 'A', kind: 'text' },
      }),
    ).toEqual({ result: { content: '## alpha\nA\n\n## zeta\nZ', kind: 'text' } })
    expect(collapse({ result: { content: 'R', kind: 'text' } })).toEqual({
      result: { content: 'R', kind: 'text' },
    })
  })

  test('源码锁：调度器 F 步对 call-workgroup 执行折叠', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toContain('const projectedOutputs')
    expect(src).toContain('isWorkgroupCall')
    expect(src).toContain('localeCompare')
  })
})

describe('RFC-243 T4 — getExecutionOutcome db assembly', () => {
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
      name: 'rfc243-outcome',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/rfc243-nowhere',
      worktreePath: '/tmp/rfc243-nowhere',
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
