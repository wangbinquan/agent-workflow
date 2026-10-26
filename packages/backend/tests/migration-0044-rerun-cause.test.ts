// RFC-098 WP-10 T-b — migration 0044 lock: node_runs.rerun_cause column.
//
// WHY THIS FILE EXISTS (regression intent):
//   The scheduler's injection gates (gate-2 isClarifyRerun and friends,
//   scheduler.ts dispatch region) switched from proxy signals (retryIndex
//   parity × derived clarify generation) to the explicit per-row cause
//   written by the mint factory (services/nodeRunMint.ts). This locks
//   (a) the column exists with the exact snake_case name the runtime reads,
//   (b) a row round-trips its cause through the drizzle schema,
//   (c) a historical-style row leaves it NULL (pre-0044 rows gate FALSE on
//       gate-2 — the documented daemon-upgrade boundary degradation).
//   If a future table rebuild drops/renames the column, these go RED.
//   (Conventions mirror migration-0043.)

import { frozenTablesOf, createFrozenEpoch1Db, FROZEN_MIGRATIONS } from './migration-freeze'
import { insertOne } from '@/platform/persistence/singleInsert'
import { frozenRawRows as rawRows } from './migration-freeze'
import { rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { RERUN_CAUSES } from '@agent-workflow/shared'

const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

async function seedTask(db: ReturnType<typeof createFrozenEpoch1Db>): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  const { workflows, tasks } = frozenTablesOf(db)
  await insertOne(db, workflows, {
    id: wfId,
    name: 'm44',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await insertOne(db, tasks, {
    id: taskId,
    name: 'm44',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/m44',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-098 migration 0044 — node_runs.rerun_cause', () => {
  test('node_runs has the rerun_cause column', () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const cols = rawRows(db, sql`PRAGMA table_info(node_runs)`) as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('rerun_cause')
  })

  test('a row round-trips its rerun_cause through the drizzle schema', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: '01M44CAUSEROW',
      taskId,
      nodeId: 'agent-1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      rerunCause: 'clarify-answer',
      startedAt: Date.now(),
    })
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01M44CAUSEROW')))[0]!
    expect(row.rerunCause).toBe('clarify-answer')
  })

  test('a historical-style row (no cause written) reads back NULL', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    await rawExec(
      db,
      sql`
      INSERT INTO node_runs (id, task_id, node_id, status, retry_index, iteration, started_at)
      VALUES ('01M44LEGACYROW', ${taskId}, 'agent-1', 'done', 0, 0, 1)
    `,
    )
    const { nodeRuns } = frozenTablesOf(db)
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01M44LEGACYROW')))[0]!
    expect(row.rerunCause).toBeNull()
  })

  test('every RERUN_CAUSES enum value is storable (column is plain TEXT, enum lives in shared)', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    for (const cause of RERUN_CAUSES) {
      const id = `01M44_${cause}`
      const { nodeRuns } = frozenTablesOf(db)
      await insertOne(db, nodeRuns, {
        id,
        taskId,
        nodeId: 'agent-1',
        status: 'pending',
        retryIndex: 0,
        iteration: 0,
        rerunCause: cause,
        startedAt: Date.now(),
      })
      const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
      expect(row.rerunCause).toBe(cause)
    }
  })
})
