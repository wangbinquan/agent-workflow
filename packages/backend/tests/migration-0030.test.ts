// LOCKS: RFC-057 — migration 0030 lifecycle_repair_audit smoke.
//
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §2.1.
// Locks in:
//   - table exists with the documented columns (no nullable on required cols,
//     nullable on optional ones)
//   - both indexes exist
//   - NO foreign keys to tasks or lifecycle_alerts (audit outlives both)
//   - INSERT + SELECT round-trip on a complete row

import { rawRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface SqlMaster {
  type: string
  name: string
  tbl_name: string | null
  sql: string | null
}

describe('RFC-057 — migration 0030 lifecycle_repair_audit', () => {
  test('table exists with the expected columns', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name='lifecycle_repair_audit'`,
    )) as SqlMaster[]
    expect(rows).toHaveLength(1)
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    for (const col of [
      '`id`',
      '`task_id`',
      '`alert_id`',
      '`alert_rule`',
      '`alert_detail_json`',
      '`option_id`',
      '`actor_user_id`',
      '`before_snapshot_json`',
      '`after_snapshot_json`',
      '`outcome`',
      '`outcome_message`',
      '`applied_at`',
    ]) {
      expect(ddl.includes(col)).toBe(true)
    }
  })

  test('no foreign keys (audit must outlive task + alert)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT sql FROM sqlite_master WHERE name='lifecycle_repair_audit'`,
    )) as { sql: string }[]
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    expect(ddl.includes('foreign key')).toBe(false)
    expect(ddl.includes('references `tasks`')).toBe(false)
    expect(ddl.includes('references `lifecycle_alerts`')).toBe(false)
  })

  test('both indexes exist', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lifecycle_repair_audit'`,
    )) as { name: string }[]
    const names = new Set(rows.map((r) => r.name))
    expect(names.has('idx_lifecycle_repair_audit_task')).toBe(true)
    expect(names.has('idx_lifecycle_repair_audit_rule')).toBe(true)
  })

  test('insert + select round-trip', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await rawExec(
      db,
      sql`
      INSERT INTO lifecycle_repair_audit
        (id, task_id, alert_id, alert_rule, alert_detail_json, option_id,
         actor_user_id, before_snapshot_json, after_snapshot_json, outcome,
         outcome_message, applied_at)
      VALUES
        ('audit-1', 't-1', 'a-1', 'S3', '{"rule":"S3"}', 'S3.demote-task',
         'u-1', '{"task":"running"}', '{"task":"interrupted"}', 'success',
         NULL, 1234567)
    `,
    )
    const rows = (await rawRows(db, sql`SELECT * FROM lifecycle_repair_audit`)) as Array<{
      id: string
      task_id: string
      alert_id: string | null
      alert_rule: string
      alert_detail_json: string
      option_id: string
      actor_user_id: string | null
      before_snapshot_json: string
      after_snapshot_json: string
      outcome: string
      outcome_message: string | null
      applied_at: number
    }>
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe('audit-1')
    expect(r.task_id).toBe('t-1')
    expect(r.alert_id).toBe('a-1')
    expect(r.alert_rule).toBe('S3')
    expect(r.option_id).toBe('S3.demote-task')
    expect(r.outcome).toBe('success')
    expect(r.outcome_message).toBeNull()
    expect(r.applied_at).toBe(1234567)
  })

  test('alert_id and actor_user_id may be null (audit survives even when caller is unknown)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await rawExec(
      db,
      sql`
      INSERT INTO lifecycle_repair_audit
        (id, task_id, alert_rule, alert_detail_json, option_id,
         before_snapshot_json, after_snapshot_json, outcome, applied_at)
      VALUES
        ('audit-2', 't-2', 'R1', '{}', 'R1.approve-run', '{}', '{}', 'apply-failed', 0)
    `,
    )
    const rows = (await rawRows(
      db,
      sql`SELECT alert_id, actor_user_id FROM lifecycle_repair_audit WHERE id='audit-2'`,
    )) as { alert_id: string | null; actor_user_id: string | null }[]
    expect(rows[0]!.alert_id).toBeNull()
    expect(rows[0]!.actor_user_id).toBeNull()
  })
})
