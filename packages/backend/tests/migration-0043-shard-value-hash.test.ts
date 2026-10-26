// RFC-098 B3 — migration 0043 lock: node_runs.shard_value_hash column.
//
// WHY THIS FILE EXISTS (regression intent):
//   The fanout shard reuse anchor was widened to
//   (taskId, nodeId, iteration, shardKey, parentNodeRunId IS NOT NULL) and a
//   done row is only replayed when its stored sha256(shard.value) matches the
//   current shard value (pickReusableShardRun, freshness.ts). This locks
//   (a) the column exists with the exact snake_case name the runtime reads,
//   (b) a shard child row round-trips its hash, (c) a historical-style row
//   leaves it NULL — the NULL=MATCH legacy policy's precondition (a pre-0043
//   done shard must stay reusable). If a future table rebuild drops/renames
//   the column, these go RED. (Conventions mirror migration-0040.)

import { frozenTablesOf, createFrozenEpoch1Db, FROZEN_MIGRATIONS } from './migration-freeze'
import { insertOne } from '@/platform/persistence/singleInsert'
import { frozenRawRows as rawRows } from './migration-freeze'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

async function seedTask(db: ReturnType<typeof createFrozenEpoch1Db>): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  const { workflows, tasks } = frozenTablesOf(db)
  await insertOne(db, workflows, {
    id: wfId,
    name: 'm43',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await insertOne(db, tasks, {
    id: taskId,
    name: 'm43',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/m43',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-098 migration 0043 — node_runs.shard_value_hash', () => {
  test('node_runs has the shard_value_hash column', () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const cols = rawRows(db, sql`PRAGMA table_info(node_runs)`) as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('shard_value_hash')
  })

  test('a fanout shard child row round-trips its value hash', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: '01FANWRAPPER',
      taskId,
      nodeId: 'fan',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
    })
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    await insertOne(db, nodeRuns, {
      id: '01SHARDCHILD',
      taskId,
      nodeId: 'inner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: '01FANWRAPPER',
      shardKey: 'a.md',
      shardValueHash: hash,
    })
    const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01SHARDCHILD'))
    expect(row?.shardValueHash).toBe(hash)
  })

  test('historical-style row leaves shard_value_hash NULL (NULL=MATCH precondition)', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: '01LEGACYSHARD',
      taskId,
      nodeId: 'inner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      shardKey: 'a.md',
    })
    const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, '01LEGACYSHARD'))
    expect(row?.shardValueHash).toBeNull()
  })
})
