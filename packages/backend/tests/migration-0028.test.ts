// RFC-053 PR-D — migration 0028 lifecycle_alerts smoke.
//
// Verifies the migration creates the table + both indexes + the FK to
// tasks. Cascade delete is intentional: when a task is hard-deleted the
// open / resolved alert history goes with it.

import { createFrozenEpoch1Db, FROZEN_MIGRATIONS } from './migration-freeze'
import { frozenRawRows as rawRows } from './migration-freeze'
import { rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

const MIGRATIONS = resolve(FROZEN_MIGRATIONS)

interface SqlMaster {
  type: string
  name: string
  tbl_name: string | null
  sql: string | null
}

describe('RFC-053 PR-D — migration 0028 lifecycle_alerts', () => {
  test('table exists with the expected columns', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name='lifecycle_alerts'`,
    )) as SqlMaster[]
    expect(rows).toHaveLength(1)
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    for (const col of [
      '`id`',
      '`task_id`',
      '`rule`',
      '`severity`',
      '`detail`',
      '`detected_at`',
      '`resolved_at`',
    ]) {
      expect(ddl.includes(col)).toBe(true)
    }
    expect(ddl.includes('references `tasks`(`id`)')).toBe(true)
    expect(ddl.includes('on delete cascade')).toBe(true)
  })

  test('both indexes exist', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lifecycle_alerts'`,
    )) as { name: string }[]
    const names = new Set(rows.map((r) => r.name))
    expect(names.has('idx_lifecycle_alerts_task')).toBe(true)
    expect(names.has('idx_lifecycle_alerts_open')).toBe(true)
  })
})

describe('RFC-053 PR-D — migration 0028 cascade delete', () => {
  test('deleting a task removes its lifecycle_alerts rows', async () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    await rawExec(db, sql`PRAGMA foreign_keys = ON`)
    await rawExec(
      db,
      sql`
      INSERT INTO workflows (id, name, definition) VALUES ('w', 'w', '{}')
    `,
    )
    await rawExec(
      db,
      sql`
      INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path,
        worktree_path, base_branch, branch, status, inputs, started_at)
      VALUES ('t1', 't', 'w', '{}', '/tmp', '/tmp', 'main',
        'agent-workflow/t1', 'running', '{}', 0)
    `,
    )
    await rawExec(
      db,
      sql`
      INSERT INTO lifecycle_alerts (id, task_id, rule, severity, detail, detected_at)
      VALUES ('a1', 't1', 'R1', 'warning', '{}', 0)
    `,
    )
    const beforeRows = (await rawRows(
      db,
      sql`SELECT id FROM lifecycle_alerts WHERE task_id='t1'`,
    )) as {
      id: string
    }[]
    expect(beforeRows).toHaveLength(1)
    await rawExec(db, sql`DELETE FROM tasks WHERE id='t1'`)
    const afterRows = (await rawRows(
      db,
      sql`SELECT id FROM lifecycle_alerts WHERE task_id='t1'`,
    )) as {
      id: string
    }[]
    expect(afterRows).toHaveLength(0)
  })
})
