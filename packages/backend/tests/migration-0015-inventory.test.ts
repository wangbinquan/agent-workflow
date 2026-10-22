// RFC-029 T2 — locks migration 0015: node_runs gains a nullable
// `inventory_snapshot_json` text column. Legacy rows inserted pre-RFC-029
// come back as NULL; new rows round-trip the serialized snapshot. If this
// test fails, the Session-tab Runtime Inventory section loses its data
// channel.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTask(db: DbClient): string {
  const wfId = ulid()
  const { workflows, tasks } = tablesOf(db)
  insertOne(db, workflows, {
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  insertOne(db, tasks, {
    name: 'fixture-task',

    id: taskId,
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
  })
  return taskId
}

describe('migration 0015 (RFC-029 node_runs.inventory_snapshot_json)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('legacy node_run rows (no inventory_snapshot_json supplied) come back as NULL', () => {
    const taskId = seedTask(db)
    const nodeRunId = ulid()
    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
    })
    const row = queryRows(db.select().from(nodeRuns))[0]!
    expect(row.inventorySnapshotJson).toBeNull()
  })

  test('captured:true snapshot serialized to JSON round-trips intact', () => {
    const taskId = seedTask(db)
    const nodeRunId = ulid()
    const snapshot = {
      captured: true,
      schemaVersion: 1,
      capturedAt: 1700000000123,
      agents: [
        {
          name: 'reviewer',
          mode: 'primary',
          modelProviderId: 'anthropic',
          modelId: 'claude-opus-4-7',
          source: 'inline',
        },
      ],
      skills: [],
      mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
      plugins: [{ specifier: 'file:///tmp/p.mjs', source: 'inline' }],
    }
    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      inventorySnapshotJson: JSON.stringify(snapshot),
    })
    const row = queryRows(db.select().from(nodeRuns))[0]!
    expect(row.inventorySnapshotJson).not.toBeNull()
    expect(JSON.parse(row.inventorySnapshotJson!)).toEqual(snapshot)
  })

  test('column exists in the live schema (sqlite_master pragma)', () => {
    const rows = queryRows(
      db.select({ name: sql<string>`name` }).from(sql`pragma_table_info('node_runs')`),
    )
    const names = rows.map((r) => r.name)
    expect(names).toContain('inventory_snapshot_json')
  })
})
