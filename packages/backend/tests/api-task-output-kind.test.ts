// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-072 — locks the REST projection of node_run_outputs.kind into the
// wire-level `kind` field on NodeRunOutput (taskNodeRunsProjection). The Outputs tab
// reads `kind` to decide whether a port is a downloadable file. Covers:
//   - persisted kind string surfaces verbatim,
//   - NULL column (legacy row / undeclared kind) surfaces as null,
//   - value (content) is unchanged alongside kind.

import {
  taskNodeRunsProjection,
  loadTaskProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { taskExecutionKind } from '@agent-workflow/shared'
import { CODE_ROUND_NODE_ID, synthesizeCodeRoundSnapshot } from '@/services/codeRoundContract'
import { getExecutionOutcome } from '@/services/execution/outcome'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

import { describeEachProvider } from './helpers/eachProvider'

async function seedTaskAndWorkflow(db: ProviderNeutralDatabase): Promise<{ taskId: string }> {
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
      // Materialize precisely the values the old SQLite 0210 trigger produced.
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
    })
    .run()
  return { taskId }
}

async function seedRun(db: ProviderNeutralDatabase, taskId: string, nodeId = 'n'): Promise<string> {
  const id = ulid()
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId, status: 'done', startedAt: Date.now() })
    .run()
  return id
}

describeEachProvider('RFC-072 — taskNodeRunsProjection surfaces output kind', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('persisted kind string surfaces verbatim; content unchanged', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const runId = await seedRun(db, taskId)
    await db
      .insert(nodeRunOutputs)
      .values({
        nodeRunId: runId,
        portName: 'doc',
        content: 'out/report.md',
        kind: 'markdown_file',
      })
      .run()
    const res = await taskNodeRunsProjection({ db: db }, taskId)
    const out = res.outputs.find((o) => o.port === 'doc')
    expect(out).toBeDefined()
    expect(out?.kind).toBe('markdown_file')
    expect(out?.value).toBe('out/report.md')
  })

  test('NULL kind (legacy / undeclared) surfaces as null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const runId = await seedRun(db, taskId)
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: runId, portName: 'summary', content: 'all good', kind: null })
      .run()
    const res = await taskNodeRunsProjection({ db: db }, taskId)
    expect(res.outputs.find((o) => o.port === 'summary')?.kind).toBeNull()
  })

  test('RFC-395 II-pre: historical code-round rows retain their task, node and outcome projections', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const codeRoundId = ulid()
    await db
      .update(tasks)
      .set({
        status: 'done',
        finishedAt: Date.now(),
        codeRoundId,
        workflowSnapshot: synthesizeCodeRoundSnapshot({
          capability: 'mr-review',
          roundSeq: 1,
          title: 'Historical review',
        }),
      })
      .where(eq(tasks.id, taskId))
    const runId = await seedRun(db, taskId, CODE_ROUND_NODE_ID)
    await db.insert(nodeRunOutputs).values({
      nodeRunId: runId,
      portName: 'round_summary',
      content: 'historical result',
      kind: 'string',
    })

    const task = await loadTaskProjection(db, taskId)
    expect(task?.codeRoundId).toBe(codeRoundId)
    expect(taskExecutionKind(task!)).toBe('code-round')
    const projection = await taskNodeRunsProjection({ db }, taskId)
    expect(projection.runs.map((run) => run.nodeId)).toEqual([CODE_ROUND_NODE_ID])
    expect(projection.outputs).toEqual([
      {
        nodeRunId: runId,
        port: 'round_summary',
        value: 'historical result',
        kind: 'string',
      },
    ])
    const outcome = await getExecutionOutcome(db, taskId)
    expect(outcome.status).toBe('done')
    expect(outcome.outputs).toEqual({
      round_summary: { content: 'historical result', kind: 'string' },
    })
    expect(outcome.warnings).toEqual([])
  })
})
