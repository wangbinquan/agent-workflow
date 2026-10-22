// RFC-074 PR-B — migration 0040 lock: node_runs.consumed_upstream_runs_json
// column + docVersions.decision accepting 'superseded'.
//
// WHY THIS FILE EXISTS (regression intent):
//   PR-B's provenance freshness reads/writes a new node_runs column and a new
//   doc_version decision value. This locks (a) the column exists with the
//   exact snake_case name the runtime reads, (b) a node_run round-trips a
//   consumed-provenance JSON map, (c) a doc_version can be marked 'superseded'
//   (the awaiting-refresh path, design §7). If a future migration rebuild
//   drops/renames the column, or the enum is tightened, these go RED.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  const { workflows, tasks } = tablesOf(db)
  await insertOne(db, workflows, {
    id: wfId,
    name: 'm40',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await insertOne(db, tasks, {
    id: taskId,
    name: 'm40',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/m40',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-074 migration 0040 — consumed_upstream_runs_json + superseded', () => {
  test('node_runs has the consumed_upstream_runs_json column', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = rawRows(db, sql`PRAGMA table_info(node_runs)`) as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('consumed_upstream_runs_json')
  })

  test('a node_run round-trips its consumed provenance map', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const consumed = JSON.stringify({ designer: '01UPSTREAMRUN', spec: '01OTHERRUN' })
    const { nodeRuns } = tablesOf(db)
    await insertOne(db, nodeRuns, {
      id: '01RUNWITHPROV',
      taskId,
      nodeId: 'review',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      consumedUpstreamRunsJson: consumed,
    })
    const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01RUNWITHPROV'))
    expect(row?.consumedUpstreamRunsJson).toBe(consumed)
  })

  test('historical-style row leaves consumed_upstream_runs_json NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = tablesOf(db)
    await insertOne(db, nodeRuns, {
      id: '01LEGACYRUN',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01LEGACYRUN'))
    expect(row?.consumedUpstreamRunsJson).toBeNull()
  })

  test("docVersions.decision accepts 'superseded'", async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns, docVersions } = tablesOf(db)
    // A review node_run to satisfy the doc_version FK.
    await insertOne(db, nodeRuns, {
      id: '01REVIEWRUN',
      taskId,
      nodeId: 'review',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, docVersions, {
      id: '01DOCV1',
      taskId,
      reviewNodeId: 'review',
      reviewNodeRunId: '01REVIEWRUN',
      sourceNodeId: 'designer',
      sourcePortName: 'spec',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'reviews/01DOCV1.md',
      decision: 'superseded',
      decisionReason: 'upstream-refreshed',
      createdAt: Date.now(),
    })
    const [row] = await db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.id, '01DOCV1'), eq(docVersions.taskId, taskId)))
    expect(row?.decision).toBe('superseded')
  })
})
