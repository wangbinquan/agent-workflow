// LOCKS: RFC-057 — stuckTaskDetector embeds `repairHint` in S1/S2/S3 detail.
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §2.2.
// Locks in:
//   - S3 with terminal review run → detail.repairHint = { kind:'review', nodeRunId }
//   - S3 with terminal clarify run only → detail.repairHint.kind = 'clarify'
//   - S1 with awaiting_review run → detail.repairHint.kind = 'review'
//   - S2 with awaiting_human run → detail.repairHint.kind = 'clarify'
//   - S4 has no repairHint (task-level only)
//   - missing candidate → no repairHint key (not even `undefined`)

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HOUR_MS = 3_600_000

async function seedTask(
  db: DbClient,
  opts: {
    status: 'pending' | 'running' | 'awaiting_review' | 'awaiting_human'
    nodes: WorkflowNode[]
    startedAtAgoMs?: number
  },
): Promise<string> {
  const taskId = ulid()
  const workflowId = ulid()
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: opts.nodes,
    edges: [],
  }
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/r',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `aw/${taskId}`,
    status: opts.status,
    inputs: '{}',
    startedAt: Date.now() - (opts.startedAtAgoMs ?? HOUR_MS * 2),
  })
  return taskId
}

async function addRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'awaiting_review' | 'awaiting_human' | 'done' | 'interrupted' | 'failed' | 'canceled',
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status,
    startedAt: Date.now() - HOUR_MS,
    finishedAt:
      status === 'awaiting_review' || status === 'awaiting_human' ? null : Date.now() - HOUR_MS / 2,
  })
  return id
}

describe('RFC-057 — stuckTaskDetector.repairHint', () => {
  test('S3 with interrupted review run → repairHint points to it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'running',
      nodes: [{ id: 'rev_1', kind: 'review' } as WorkflowNode],
    })
    const runId = await addRun(db, taskId, 'rev_1', 'interrupted')
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    expect(r.openAlerts).toHaveLength(1)
    expect(r.openAlerts[0]!.detail).toMatchObject({
      rule: 'S3',
      repairHint: { kind: 'review', nodeRunId: runId },
    })
  })

  test('S3 with terminal clarify run only → repairHint.kind=clarify', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'running',
      nodes: [{ id: 'clarify_1', kind: 'clarify' } as WorkflowNode],
    })
    const runId = await addRun(db, taskId, 'clarify_1', 'interrupted')
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    expect(r.openAlerts[0]!.detail).toMatchObject({
      rule: 'S3',
      repairHint: { kind: 'clarify', nodeRunId: runId },
    })
  })

  test('S1 with awaiting_review run → repairHint.kind=review', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'awaiting_review',
      nodes: [{ id: 'rev_1', kind: 'review' } as WorkflowNode],
    })
    const runId = await addRun(db, taskId, 'rev_1', 'awaiting_review')
    // No doc_versions → S1 violates.
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    expect(r.openAlerts.map((a) => a.rule)).toContain('S1')
    const s1 = r.openAlerts.find((a) => a.rule === 'S1')!
    expect(s1.detail).toMatchObject({
      repairHint: { kind: 'review', nodeRunId: runId },
    })
  })

  test('S2 with awaiting_human clarify run → repairHint.kind=clarify', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'awaiting_human',
      nodes: [{ id: 'clarify_1', kind: 'clarify' } as WorkflowNode],
    })
    const runId = await addRun(db, taskId, 'clarify_1', 'awaiting_human')
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    const s2 = r.openAlerts.find((a) => a.rule === 'S2')
    expect(s2?.detail).toMatchObject({
      repairHint: { kind: 'clarify', nodeRunId: runId },
    })
  })

  test('S4 has NO repairHint (task-level only)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'pending',
      nodes: [],
      startedAtAgoMs: 10 * 60 * 1000,
    })
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    const s4 = r.openAlerts.find((a) => a.rule === 'S4')
    expect(s4).toBeDefined()
    expect(s4!.detail).not.toHaveProperty('repairHint')
  })

  test('no candidate → no repairHint key emitted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, {
      status: 'running',
      // Output node only — neither review nor clarify ever lands here.
      nodes: [{ id: 'out_1', kind: 'output', ports: [] } as unknown as WorkflowNode],
    })
    await addRun(db, taskId, 'out_1', 'done')
    const r = await runStuckTaskDetector({
      operations: taskRecoveryOperations(db),
      taskIdFilter: [taskId],
    })
    expect(r.openAlerts[0]!.detail).not.toHaveProperty('repairHint')
  })
})
