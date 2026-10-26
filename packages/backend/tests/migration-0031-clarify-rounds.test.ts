// RFC-058 T11 — migration 0031 lock: builds clarify_rounds with the unified
// schema + DB CHECK constraints + indexes; copies rows from clarify_sessions
// and cross_clarify_sessions verbatim (column-mapping); old tables remain
// for staged service migration.
//
// Stage 2 (migration 0032, follow-up) drops the old tables after services
// switch to read/write the new table.

import {
  frozenTablesOf,
  createFrozenEpoch1Db,
  LAST_LEGACY_CLARIFY_IDX,
  freezeAt,
  FROZEN_MIGRATIONS,
} from './migration-freeze'
import { insertOne } from '@/platform/persistence/singleInsert'
import { queryRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

async function seedTask(db: ReturnType<typeof createFrozenEpoch1Db>): Promise<string> {
  const id = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${id}`
  const def = { $schema_version: 3, inputs: [], nodes: [], edges: [], outputs: [] }
  const { workflows, tasks } = frozenTablesOf(db)
  await insertOne(db, workflows, {
    id: wfId,
    name: 'mig-test',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await insertOne(db, tasks, {
    id,
    name: 'mig-test',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-mig-0031/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return id
}

describe('RFC-058 migration 0031 — clarify_rounds table shape', () => {
  test('clarify_rounds table exists with all columns + indexes after migrate', () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    // sqlite_master lookup confirms the migration ran and table exists.
    const tables = queryRows(
      db
        .select({ name: sql<string>`name` })
        .from(sql`sqlite_master`)
        .where(sql`type = 'table' AND name = 'clarify_rounds'`),
    ) as Array<{ name: string }>
    expect(tables.length).toBe(1)
    // Indexes also present
    const indexes = queryRows(
      db
        .select({ name: sql<string>`name` })
        .from(sql`sqlite_master`)
        .where(sql`type = 'index' AND tbl_name = 'clarify_rounds'`),
    ) as Array<{ name: string }>
    const idxNames = indexes.map((r) => r.name)
    expect(idxNames).toContain('idx_clarify_rounds_task')
    expect(idxNames).toContain('idx_clarify_rounds_kind_status')
    expect(idxNames).toContain('idx_clarify_rounds_asking')
    expect(idxNames).toContain('idx_clarify_rounds_intermediary')
    expect(idxNames).toContain('idx_clarify_rounds_target_consumer')
  })

  test('legacy clarify_sessions and cross_clarify_sessions still exist post-stage-1 (era-locked at 0106; 0107 drops them)', () => {
    const db = createFrozenEpoch1Db(freezeAt(LAST_LEGACY_CLARIFY_IDX))
    const t = queryRows(
      db
        .select({ name: sql<string>`name` })
        .from(sql`sqlite_master`)
        .where(sql`type = 'table' AND name IN ('clarify_sessions','cross_clarify_sessions')`),
    ) as Array<{ name: string }>
    expect(t.length).toBe(2)
  })
})

describe('RFC-058 migration 0031 — DB CHECK kind × status invariant', () => {
  test('rejects kind=self + status=abandoned (CR-1 invariant is cross-only)', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns, clarifyRounds } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'clarify1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    expect(() => {
      return insertOne(db, clarifyRounds, {
        id: 'r1',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_a',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_b',
        iteration: 0,
        questionsJson: '[]',
        status: 'abandoned', // ← violates CHECK
      })
    }).toThrow(/Failed to run the query|CHECK constraint/i)
  })

  test('rejects kind=cross + status=canceled (task-cancel path is self-only)', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns, clarifyRounds } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'cc1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    expect(() => {
      return insertOne(db, clarifyRounds, {
        id: 'r2',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_a',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_b',
        iteration: 0,
        questionsJson: '[]',
        status: 'canceled', // ← violates CHECK
      })
    }).toThrow(/Failed to run the query|CHECK constraint/i)
  })

  test('accepts legitimate (self, canceled) and (cross, abandoned) combinations', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns, clarifyRounds } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'clarify1',
      status: 'canceled',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, clarifyRounds, {
      id: 'r3',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_a',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_b',
      iteration: 0,
      questionsJson: '[]',
      status: 'canceled',
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_c',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_d',
      taskId,
      nodeId: 'cc1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, clarifyRounds, {
      id: 'r4',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_c',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_d',
      iteration: 0,
      questionsJson: '[]',
      status: 'abandoned',
    })
    const rows = await db.select({ id: clarifyRounds.id }).from(clarifyRounds)
    expect(rows.length).toBe(2)
  })
})

describe('RFC-058 migration 0031 — kind enum + directive CHECK', () => {
  test('rejects an unknown kind literal', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'clarify1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    expect(() =>
      rawExec(
        db,
        sql`INSERT INTO clarify_rounds (
        id, task_id, kind, asking_node_id, asking_node_run_id,
        intermediary_node_id, intermediary_node_run_id, iteration,
        questions_json, status
      ) VALUES (
        'r_bad_kind', ${taskId}, 'hybrid', 'designer', 'nr_a',
        'clarify1', 'nr_b', 0, '[]', 'awaiting_human'
      )`,
      ),
    ).toThrow(/Failed to run the query|CHECK constraint/i)
  })

  test('rejects directive other than continue/stop', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'clarify1',
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    })
    expect(() =>
      rawExec(
        db,
        sql`INSERT INTO clarify_rounds (
        id, task_id, kind, asking_node_id, asking_node_run_id,
        intermediary_node_id, intermediary_node_run_id, iteration,
        questions_json, status, directive
      ) VALUES (
        'r_bad_dir', ${taskId}, 'self', 'designer', 'nr_a',
        'clarify1', 'nr_b', 0, '[]', 'answered', 'restart'
      )`,
      ),
    ).toThrow(/Failed to run the query|CHECK constraint/i)
  })
})

describe('RFC-058 migration 0031 →（RFC-217 T8 终态）冻结形状落统一表', () => {
  test('冻结 self/cross 行写入 clarify_rounds 并可读回（双表时代结束）', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const taskId = await seedTask(db)
    const { nodeRuns, clarifyRounds } = frozenTablesOf(db)
    await insertOne(db, nodeRuns, {
      id: 'nr_a',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, clarifyRounds, {
      kind: 'self',
      loopIter: 0,
      createdAt: Date.now(),
      id: 'legacy-self',
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_a',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_a',
      iteration: 0,
      questionsJson: '[]',
    })
    const selfRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, 'legacy-self'))
    expect(selfRows.length).toBe(1)

    await insertOne(db, nodeRuns, {
      id: 'nr_b',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await insertOne(db, clarifyRounds, {
      kind: 'cross',
      loopIter: 0,
      iteration: 0,
      createdAt: Date.now(),
      id: 'legacy-cross',
      taskId,
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_b',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_b',
      questionsJson: '[]',
    })
    const crossRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, 'legacy-cross'))
    expect(crossRows.length).toBe(1)
  })
})
