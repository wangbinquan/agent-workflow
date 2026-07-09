import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-D — task-level invariants T1/T2/T3/U1.
//
//   T1  task.status='awaiting_review' ⟹ ∃ node_run.status='awaiting_review'
//   T2  task.status='awaiting_human'  ⟹ ∃ node_run.status='awaiting_human'
//   T3  task.status='done'            ⟹ every output node has done node_run
//   U1  per (task, nodeId, reviewIter, clarifyIter, shardKey) ≤ 1 row in
//       {awaiting_review, awaiting_human}

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(taskStatus: TaskStatus, nodes: WorkflowNode[]): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-prd-task-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const def: WorkflowDefinition = { $schema_version: 2, inputs: [], nodes, edges: [] }
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId, cleanup: () => rimrafDir(tmp) }
}

async function insertRun(
  db: DbClient,
  taskId: string,
  opts: {
    nodeId: string
    status: TaskStatus | 'skipped' | 'exhausted'
    reviewIteration?: number
    clarifyIteration?: number
    shardKey?: string | null
    finishedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: opts.reviewIteration ?? 0,
    shardKey: opts.shardKey ?? null,
    status: opts.status,
    startedAt: Date.now() - 100,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

describe('RFC-053 PR-D — T1 (task awaiting_review ⟹ ∃ awaiting_review run)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: task awaiting_review + one awaiting_review run → no T1 alert', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'awaiting_review' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T1')).toHaveLength(0)
  })

  test('violated: task awaiting_review + no awaiting_review run → T1 alert', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'done', finishedAt: Date.now() })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const t1 = result.openAlerts.filter((a) => a.rule === 'T1')
    expect(t1).toHaveLength(1)
    expect(t1[0]!.detail).toMatchObject({ rule: 'T1', taskId: h.taskId })
  })
})

describe('RFC-053 PR-D — T2 (task awaiting_human ⟹ ∃ awaiting_human run)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: task awaiting_human + clarify run awaiting_human → no T2 alert', async () => {
    h = await buildHarness('awaiting_human', [{ id: 'clr', kind: 'clarify' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'awaiting_human' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(0)
  })

  test('violated: task awaiting_human + no awaiting_human run → T2 alert', async () => {
    h = await buildHarness('awaiting_human', [{ id: 'clr', kind: 'clarify' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'running' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(1)
  })
})

describe('RFC-053 PR-D — T3 (task done ⟹ every output node has done run)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: task done + all output runs done → no T3 alert', async () => {
    h = await buildHarness('done', [
      { id: 'out_a', kind: 'output' } as WorkflowNode,
      { id: 'out_b', kind: 'output' } as WorkflowNode,
    ])
    await insertRun(h.db, h.taskId, { nodeId: 'out_a', status: 'done', finishedAt: Date.now() })
    await insertRun(h.db, h.taskId, { nodeId: 'out_b', status: 'done', finishedAt: Date.now() })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T3')).toHaveLength(0)
  })

  test('violated: task done but one output run still pending → T3 alert', async () => {
    h = await buildHarness('done', [
      { id: 'out_a', kind: 'output' } as WorkflowNode,
      { id: 'out_b', kind: 'output' } as WorkflowNode,
    ])
    await insertRun(h.db, h.taskId, { nodeId: 'out_a', status: 'done', finishedAt: Date.now() })
    await insertRun(h.db, h.taskId, { nodeId: 'out_b', status: 'pending' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const t3 = result.openAlerts.filter((a) => a.rule === 'T3')
    expect(t3).toHaveLength(1)
    expect((t3[0]!.detail as { missingOutputNodeIds: string[] }).missingOutputNodeIds).toEqual([
      'out_b',
    ])
  })

  test('vacuous: task done + no output nodes in workflow → no T3 alert', async () => {
    h = await buildHarness('done', [
      { id: 'a', kind: 'agent-single', agentName: 'a', promptTemplate: '' } as WorkflowNode,
    ])
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'done', finishedAt: Date.now() })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T3')).toHaveLength(0)
  })
})

describe('RFC-053 PR-D — U1 (≤ 1 active run per (task,node,iter,shard))', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: one awaiting_review run on a node → no U1 alert', async () => {
    h = await buildHarness('running', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'awaiting_review' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'U1')).toHaveLength(0)
  })

  test('violated: two awaiting_review runs same (node,iter) → U1 alert', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    const a = await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'awaiting_review' })
    const b = await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'awaiting_review' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const u1 = result.openAlerts.filter((a) => a.rule === 'U1')
    expect(u1).toHaveLength(1)
    const ids = (u1[0]!.detail as { nodeRunIds: string[] }).nodeRunIds.sort()
    expect(ids).toEqual([a, b].sort())
  })

  test('iteration disambiguates: two runs different reviewIteration → no U1 alert', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      reviewIteration: 0,
    })
    await insertRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      reviewIteration: 1,
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'U1')).toHaveLength(0)
  })

  test('shardKey disambiguates: two runs different shardKey → no U1 alert', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      shardKey: 'a.md',
    })
    await insertRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      shardKey: 'b.md',
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'U1')).toHaveLength(0)
  })
})

describe('RFC-053 PR-D — scope selectors', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('{ taskId } scopes to a single task', async () => {
    h = await buildHarness('awaiting_review', [{ id: 'rev_1', kind: 'review' } as WorkflowNode])
    await insertRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'done', finishedAt: Date.now() })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.scanned).toBe(1)
  })

  test('{ taskId } unknown id → scanned=0, no alerts', async () => {
    h = await buildHarness('running', [])
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: 'nonexistent' } })
    expect(result.scanned).toBe(0)
    expect(result.openAlerts).toEqual([])
  })

  test('{ all: true } scans every non-deleted task', async () => {
    h = await buildHarness('running', [])
    const result = await runLifecycleInvariants({ db: h.db, scope: { all: true } })
    expect(result.scanned).toBe(1)
  })
})
