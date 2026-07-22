// RFC-056 — migration 0029 cross_clarify_sessions + node_runs.cross_clarify_iteration.
//
// LOCKS: table exists with all columns + 4 indexes + 3 FKs cascade-delete;
// node_runs.cross_clarify_iteration column added with default 0 (zero
// rewrite cost for already-stored RFC-023+ rows). If any of these go red
// the runtime in PR-B cannot persist cross-clarify sessions — investigate
// before relaxing.

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
// RFC-217 T8: migration 0107 drops cross_clarify_sessions — the table-shape
// locks below are era-locks, frozen at the last idx where the table exists.
import { LAST_LEGACY_CLARIFY_IDX, MIGRATIONS, freezeAt } from './migration-freeze'

const FROZEN = freezeAt(LAST_LEGACY_CLARIFY_IDX)

interface SqlMaster {
  type: string
  name: string
  tbl_name: string | null
  sql: string | null
}

interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

describe('RFC-056 — migration 0029 cross_clarify_sessions', () => {
  test('cross_clarify_sessions table exists with all expected columns', async () => {
    const db = createInMemoryDb(FROZEN)
    const rows = (await db.all(
      sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name='cross_clarify_sessions'`,
    )) as SqlMaster[]
    expect(rows).toHaveLength(1)
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    for (const col of [
      '`id`',
      '`task_id`',
      '`cross_clarify_node_id`',
      '`cross_clarify_node_run_id`',
      '`source_questioner_node_id`',
      '`source_questioner_node_run_id`',
      '`target_designer_node_id`',
      '`loop_iter`',
      '`iteration`',
      '`questions_json`',
      '`answers_json`',
      '`directive`',
      '`status`',
      '`designer_run_triggered_at`',
      '`created_at`',
      '`answered_at`',
      '`abandoned_at`',
    ]) {
      expect(ddl.includes(col)).toBe(true)
    }
  })

  test('FK to tasks + node_runs(2 — RFC-132 PR-F dropped the RFC-070 consumption-stamp FKs) with cascade delete', async () => {
    const db = createInMemoryDb(FROZEN)
    const rows = (await db.all(
      sql`SELECT sql FROM sqlite_master WHERE name='cross_clarify_sessions'`,
    )) as SqlMaster[]
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    expect(ddl.includes('references `tasks`(`id`)')).toBe(true)
    expect(ddl.includes('references `node_runs`(`id`)')).toBe(true)
    // Two FKs to node_runs (RFC-132 PR-F migration 0073 dropped the two RFC-070 stamp FKs):
    //   - cross_clarify_node_run_id (RFC-056)
    //   - source_questioner_node_run_id (RFC-056)
    const nodeRunRefs = ddl.match(/references `node_runs`/g) ?? []
    expect(nodeRunRefs.length).toBe(2)
    expect(ddl.includes('on delete cascade')).toBe(true)
    // (RFC-132 PR-F: the RFC-070 SET NULL stamp FKs were dropped by migration 0073 —
    // no `on delete set null` remains on this table.)
    expect(ddl.includes('on delete set null')).toBe(false)
  })

  test('all 4 indexes exist', async () => {
    const db = createInMemoryDb(FROZEN)
    const rows = (await db.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cross_clarify_sessions'`,
    )) as { name: string }[]
    const names = new Set(rows.map((r) => r.name))
    expect(names.has('idx_cross_clarify_sessions_task')).toBe(true)
    expect(names.has('idx_cross_clarify_sessions_node')).toBe(true)
    expect(names.has('idx_cross_clarify_sessions_designer')).toBe(true)
    expect(names.has('idx_cross_clarify_sessions_status')).toBe(true)
  })

  test('status column default is "awaiting_human"', async () => {
    const db = createInMemoryDb(FROZEN)
    const cols = (await db.all(sql`PRAGMA table_info(cross_clarify_sessions)`)) as ColumnInfo[]
    const statusCol = cols.find((c) => c.name === 'status')
    expect(statusCol).toBeDefined()
    expect(String(statusCol?.dflt_value)).toContain('awaiting_human')
    expect(statusCol?.notnull).toBe(1)
  })

  test('directive column is nullable (NULL while awaiting_human)', async () => {
    const db = createInMemoryDb(FROZEN)
    const cols = (await db.all(sql`PRAGMA table_info(cross_clarify_sessions)`)) as ColumnInfo[]
    const directiveCol = cols.find((c) => c.name === 'directive')
    expect(directiveCol).toBeDefined()
    expect(directiveCol?.notnull).toBe(0)
  })
})

describe('RFC-056 → RFC-064 — node_runs.cross_clarify_iteration column lifecycle', () => {
  // RFC-056 migration 0029 originally added `cross_clarify_iteration` to
  // `node_runs`. RFC-064 migration 0035 max-merges that column into
  // `clarify_iteration` and DROPs it. After the full migration sequence runs
  // on a fresh DB the column is gone — we lock its absence here so any
  // future revival of the two-counter design is caught loudly.
  test('after RFC-064 the column is absent from node_runs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(node_runs)`)) as ColumnInfo[]
    const col = cols.find((c) => c.name === 'cross_clarify_iteration')
    expect(col).toBeUndefined()
  })

  test('review_iteration / retry_index remain; both clarify counters are gone (RFC-074 PR-C)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(node_runs)`)) as ColumnInfo[]
    const names = new Set(cols.map((c) => c.name))
    expect(names.has('cross_clarify_iteration')).toBe(false)
    // RFC-074 PR-C migration 0041 dropped clarify_iteration too — freshness is
    // pure ULID id-order, the generation is derived from prior-done id-order.
    expect(names.has('clarify_iteration')).toBe(false)
    expect(names.has('review_iteration')).toBe(true)
    expect(names.has('retry_index')).toBe(true)
  })
})
