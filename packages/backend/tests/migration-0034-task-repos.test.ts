// LOCKS: RFC-066 — migration 0034 task_repos smoke + backfill + new columns.
//
// Three blocks of coverage:
//   1. task_repos table + the two indexes exist with the expected DDL shape.
//   2. tasks.repo_count column exists (NOT NULL DEFAULT 1) so every legacy
//      row reads back as repo_count=1 without writes.
//   3. node_runs.pre_snapshot_repos_json column exists (nullable TEXT) so
//      single-repo tasks continue to use pre_snapshot and multi-repo
//      writes can land per-repo stash maps.
//   4. Backfill: an existing tasks row (inserted before the trigger fires)
//      gets a single task_repos row with repo_index=0 + worktree_dir_name=''
//      mirroring tasks.* columns.

import { rawRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb, openDb } from '../src/db/client'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface SqlMaster {
  type: string
  name: string
  tbl_name: string | null
  sql: string | null
}

describe('RFC-066 — migration 0034 task_repos', () => {
  test('task_repos table + two indexes exist with expected DDL shape', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const tbl = (await rawRows(
      db,
      sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name='task_repos'`,
    )) as SqlMaster[]
    expect(tbl).toHaveLength(1)
    const ddl = (tbl[0]!.sql ?? '').toLowerCase()
    // Columns we need.
    for (const col of [
      '`task_id`',
      '`repo_index`',
      '`repo_path`',
      '`repo_url`',
      '`base_branch`',
      '`branch`',
      '`base_commit`',
      '`worktree_path`',
      '`worktree_dir_name`',
      '`has_submodules`',
      '`submodule_init_ok`',
      '`submodule_init_error`',
      '`schema_version`',
    ]) {
      expect(ddl.includes(col)).toBe(true)
    }
    // Composite PK.
    expect(/primary key.*task_id.*repo_index/.test(ddl)).toBe(true)

    const idxs = (await rawRows(
      db,
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_repos'`,
    )) as { name: string }[]
    const names = idxs.map((r) => r.name)
    expect(names).toContain('idx_task_repos_repo_path')
    expect(names).toContain('idx_task_repos_repo_url')
  })

  test('tasks.repo_count column exists (NOT NULL DEFAULT 1)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await rawRows(db, sql`PRAGMA table_info(tasks)`)) as Array<{
      name: string
      notnull: number
      dflt_value: string | null
      type: string
    }>
    const repoCount = cols.find((c) => c.name === 'repo_count')
    expect(repoCount).toBeDefined()
    expect(repoCount?.notnull).toBe(1)
    expect(repoCount?.dflt_value).toBe('1')
  })

  test('node_runs.pre_snapshot_repos_json column exists (nullable TEXT)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await rawRows(db, sql`PRAGMA table_info(node_runs)`)) as Array<{
      name: string
      notnull: number
      type: string
    }>
    const col = cols.find((c) => c.name === 'pre_snapshot_repos_json')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
    expect((col?.type ?? '').toUpperCase()).toBe('TEXT')
  })

  test('backfill: pre-existing tasks row materializes one task_repos row with repo_index=0', async () => {
    // Build a partial migration sequence up to (but not including) 0034,
    // seed a legacy task row, then apply 0034 on top and verify the
    // single-row INSERT FROM ... SELECT backfill ran.
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc066-backfill-'))
    const partialMigDir = join(home, 'migrations')
    mkdirSync(join(partialMigDir, 'meta'), { recursive: true })

    // Copy all migrations EXCEPT 0034 and the journal entries past idx 32.
    const sqlFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
    for (const f of sqlFiles) {
      if (f.startsWith('0034_')) continue
      writeFileSync(join(partialMigDir, f), readFileSync(join(MIGRATIONS, f), 'utf-8'))
    }
    const journalRaw = readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8')
    const journal = JSON.parse(journalRaw) as {
      entries: Array<{ idx: number; tag: string; [k: string]: unknown }>
    }
    journal.entries = journal.entries.filter((e) => e.idx <= 32)
    writeFileSync(join(partialMigDir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2))

    // Apply up to 0033 (idx=32, RFC-067 head pre-RFC-066).
    const dbPath = join(home, 'db.sqlite')
    const intermediate = openDb({ path: dbPath, migrationsFolder: partialMigDir })
    intermediate.$client.close()

    // Seed a legacy task row using raw SQLite (no schema awareness).
    const raw = new Database(dbPath)
    raw.exec("INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'fixture', '{}')")
    raw.exec(`
      INSERT INTO tasks
        (id, name, workflow_id, workflow_snapshot, repo_path, repo_url,
         worktree_path, base_branch, branch, base_commit, status, inputs,
         started_at, schema_version)
      VALUES
        ('t-legacy', 'legacy task', 'wf-1', '{}', '/tmp/source-repo', NULL,
         '/tmp/wt/t-legacy', 'main', 'agent-workflow/t-legacy', 'abc123',
         'done', '{}', 1, 1)
    `)
    raw.close()

    // Apply the rest (just 0034) using the full migrations folder.
    const final = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const rows = (await rawRows(
      final,
      sql`SELECT * FROM task_repos WHERE task_id = 't-legacy'`,
    )) as Array<{
      task_id: string
      repo_index: number
      repo_path: string
      repo_url: string | null
      base_branch: string
      branch: string
      base_commit: string | null
      worktree_path: string
      worktree_dir_name: string
      has_submodules: number | null
      submodule_init_ok: number | null
      submodule_init_error: string | null
      schema_version: number
    }>
    final.$client.close()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.repo_index).toBe(0)
    expect(rows[0]!.repo_path).toBe('/tmp/source-repo')
    expect(rows[0]!.repo_url).toBeNull()
    expect(rows[0]!.base_branch).toBe('main')
    expect(rows[0]!.branch).toBe('agent-workflow/t-legacy')
    expect(rows[0]!.base_commit).toBe('abc123')
    expect(rows[0]!.worktree_path).toBe('/tmp/wt/t-legacy')
    // Legacy single-repo backfill uses empty worktree_dir_name (the worktree
    // IS the repo, no parent multi-repo dir).
    expect(rows[0]!.worktree_dir_name).toBe('')
    expect(rows[0]!.has_submodules).toBeNull()
    expect(rows[0]!.submodule_init_ok).toBeNull()
    expect(rows[0]!.submodule_init_error).toBeNull()
    expect(rows[0]!.schema_version).toBe(1)
  })

  test('cascade delete: deleting a task removes its task_repos rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await rawExec(db, sql`INSERT INTO workflows (id, name, definition) VALUES ('wf-1', 'f', '{}')`)
    await rawExec(
      db,
      sql`
      INSERT INTO tasks
        (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
         base_branch, branch, status, inputs, started_at, schema_version)
      VALUES
        ('t-cascade', 'cascade', 'wf-1', '{}', '/p', '/w',
         'main', 'agent-workflow/t-cascade', 'done', '{}', 1, 1)
    `,
    )
    await rawExec(
      db,
      sql`
      INSERT INTO task_repos
        (task_id, repo_index, repo_path, branch, worktree_path)
      VALUES
        ('t-cascade', 0, '/p', 'agent-workflow/t-cascade', '/w'),
        ('t-cascade', 1, '/p2', 'agent-workflow/t-cascade', '/w/p2')
    `,
    )
    const before = (await rawRows(
      db,
      sql`SELECT count(*) AS n FROM task_repos WHERE task_id='t-cascade'`,
    )) as { n: number }[]
    expect(before[0]!.n).toBe(2)
    await rawExec(db, sql`DELETE FROM tasks WHERE id='t-cascade'`)
    const after = (await rawRows(
      db,
      sql`SELECT count(*) AS n FROM task_repos WHERE task_id='t-cascade'`,
    )) as { n: number }[]
    expect(after[0]!.n).toBe(0)
  })
})
