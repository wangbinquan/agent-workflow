import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface IndexListRow {
  name: string
}

interface IndexInfoRow {
  seqno: number
  name: string
}

interface QueryPlanRow {
  detail: string
}

describe('migration 0128 — task operations indexes', () => {
  test('composite indexes replace their redundant single-column predecessors', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const indexes = db.all<IndexListRow>(sql`PRAGMA index_list(tasks)`).map((row) => row.name)

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_tasks_list_started_id',
        'idx_tasks_list_status_started_id',
        'idx_tasks_list_parent_started_id',
        'idx_tasks_list_owner_started_id',
      ]),
    )
    expect(indexes).not.toContain('idx_tasks_status')
    expect(indexes).not.toContain('idx_tasks_parent')
    expect(indexes).not.toContain('idx_tasks_owner')
  })

  test.each([
    ['idx_tasks_list_started_id', ['started_at', 'id']],
    ['idx_tasks_list_status_started_id', ['status', 'started_at', 'id']],
    ['idx_tasks_list_parent_started_id', ['parent_task_id', 'started_at', 'id']],
    ['idx_tasks_list_owner_started_id', ['owner_user_id', 'started_at', 'id']],
  ] as const)('%s has the intended keyset prefix', (indexName, columns) => {
    const db = createInMemoryDb(MIGRATIONS)
    const info = db
      .all<IndexInfoRow>(sql.raw(`PRAGMA index_info('${indexName}')`))
      .sort((a, b) => a.seqno - b.seqno)
    expect(info.map((row) => row.name)).toEqual([...columns])
  })

  test('representative status/parent/owner keyset plans use the composite indexes', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const plans = [
      db.all<QueryPlanRow>(sql`
        EXPLAIN QUERY PLAN
        SELECT id FROM tasks
        WHERE status = 'running'
        ORDER BY started_at DESC, id DESC
        LIMIT 50
      `),
      db.all<QueryPlanRow>(sql`
        EXPLAIN QUERY PLAN
        SELECT id FROM tasks
        WHERE parent_task_id = 'parent'
        ORDER BY started_at DESC, id DESC
        LIMIT 50
      `),
      db.all<QueryPlanRow>(sql`
        EXPLAIN QUERY PLAN
        SELECT id FROM tasks
        WHERE owner_user_id = 'owner'
        ORDER BY started_at DESC, id DESC
        LIMIT 50
      `),
    ].map((rows) => rows.map((row) => row.detail).join('\n'))

    expect(plans[0]).toContain('idx_tasks_list_status_started_id')
    expect(plans[1]).toContain('idx_tasks_list_parent_started_id')
    expect(plans[2]).toContain('idx_tasks_list_owner_started_id')
  })
})
