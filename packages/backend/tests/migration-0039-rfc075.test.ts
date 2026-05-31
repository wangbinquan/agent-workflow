// LOCKS: RFC-075 — migration 0039 adds the working-branch + auto-commit&push
// columns. All four are additive and backward compatible:
//   * tasks.working_branch        nullable TEXT  (NULL = isolation branch)
//   * tasks.auto_commit_push      INTEGER NOT NULL DEFAULT 0 (off = legacy)
//   * task_repos.working_branch   nullable TEXT  (multi-repo mirror)
//   * node_runs.commit_push_json  nullable TEXT  (commit-node marker/meta)
// A regression that drops the DEFAULT 0 on auto_commit_push would flip every
// legacy task into auto-commit mode on read; this test pins it.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface ColInfo {
  name: string
  notnull: number
  dflt_value: string | null
  type: string
}

describe('RFC-075 — migration 0039 columns', () => {
  test('tasks.working_branch exists (nullable TEXT)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(tasks)`)) as ColInfo[]
    const col = cols.find((c) => c.name === 'working_branch')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
    expect((col?.type ?? '').toUpperCase()).toBe('TEXT')
  })

  test('tasks.auto_commit_push exists (NOT NULL DEFAULT 0)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(tasks)`)) as ColInfo[]
    const col = cols.find((c) => c.name === 'auto_commit_push')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(1)
    expect(col?.dflt_value).toBe('0')
  })

  test('task_repos.working_branch exists (nullable TEXT)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(task_repos)`)) as ColInfo[]
    const col = cols.find((c) => c.name === 'working_branch')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
    expect((col?.type ?? '').toUpperCase()).toBe('TEXT')
  })

  test('node_runs.commit_push_json exists (nullable TEXT)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(node_runs)`)) as ColInfo[]
    const col = cols.find((c) => c.name === 'commit_push_json')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
    expect((col?.type ?? '').toUpperCase()).toBe('TEXT')
  })

  test('a task inserted without the new columns reads back working_branch=NULL, auto_commit_push=0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'f', '{}')`)
    await db.run(sql`
      INSERT INTO tasks
        (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at, schema_version)
      VALUES
        ('t-legacy', 'legacy', 'wf-1', '{}', '/p', '/w',
         'main', 'agent-workflow/t-legacy', 'done', '{}', 1, 1)
    `)
    const rows = (await db.all(
      sql`SELECT working_branch, auto_commit_push FROM tasks WHERE id='t-legacy'`,
    )) as Array<{ working_branch: string | null; auto_commit_push: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.working_branch).toBeNull()
    expect(rows[0]!.auto_commit_push).toBe(0)
  })
})
