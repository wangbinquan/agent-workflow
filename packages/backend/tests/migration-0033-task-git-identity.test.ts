// LOCKS: RFC-067 — migration 0033 task_git_identity smoke.
//
// Two nullable TEXT columns on the existing `tasks` table; default behavior
// is "both NULL" (byte-identical to pre-RFC-067). No backfill, no index, no
// constraint. The XOR (only one set) is rejected at StartTaskSchema, not at
// the DB level.

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

describe('RFC-067 — migration 0033 task_git_identity', () => {
  test('tasks table gains git_user_name + git_user_email columns', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = (await rawRows(
      db,
      sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name='tasks'`,
    )) as SqlMaster[]
    expect(rows).toHaveLength(1)
    const ddl = (rows[0]!.sql ?? '').toLowerCase()
    expect(ddl.includes('`git_user_name`')).toBe(true)
    expect(ddl.includes('`git_user_email`')).toBe(true)
  })

  test('both columns nullable (no `not null` on either)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await rawRows(db, sql`PRAGMA table_info(tasks)`)) as Array<{
      name: string
      notnull: number
    }>
    const name = cols.find((c) => c.name === 'git_user_name')
    const email = cols.find((c) => c.name === 'git_user_email')
    expect(name?.notnull).toBe(0)
    expect(email?.notnull).toBe(0)
  })

  test('a row that omits both columns gets NULL for both (legacy behavior)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await rawExec(
      db,
      sql`INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'fixture', '{}')`,
    )
    await rawExec(
      db,
      sql`
      INSERT INTO tasks
        (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at, schema_version)
      VALUES
        ('t-legacy', 'legacy task', 'wf-1', '{}', '/tmp/repo', '/tmp/wt',
         'main', 'agent-workflow/t-legacy', 'pending', '{}', 1, 1)
    `,
    )
    const rows = (await rawRows(
      db,
      sql`SELECT git_user_name, git_user_email FROM tasks WHERE id='t-legacy'`,
    )) as { git_user_name: string | null; git_user_email: string | null }[]
    expect(rows[0]!.git_user_name).toBeNull()
    expect(rows[0]!.git_user_email).toBeNull()
  })

  test('a row with both columns set round-trips verbatim', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await rawExec(
      db,
      sql`INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'fixture', '{}')`,
    )
    await rawExec(
      db,
      sql`
      INSERT INTO tasks
        (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at, schema_version,
         git_user_name, git_user_email)
      VALUES
        ('t-identity', 'with identity', 'wf-1', '{}', '/tmp/repo', '/tmp/wt',
         'main', 'agent-workflow/t-identity', 'pending', '{}', 1, 1,
         'AI Bot', 'bot@workflow.local')
    `,
    )
    const rows = (await rawRows(
      db,
      sql`SELECT git_user_name, git_user_email FROM tasks WHERE id='t-identity'`,
    )) as { git_user_name: string; git_user_email: string }[]
    expect(rows[0]!.git_user_name).toBe('AI Bot')
    expect(rows[0]!.git_user_email).toBe('bot@workflow.local')
  })
})
