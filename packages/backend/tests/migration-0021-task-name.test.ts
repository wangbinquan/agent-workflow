// RFC-037 T2 — locks migration 0021: tasks gains `name TEXT`, with the
// UPDATE backfill setting historical rows to `workflows.name` (or a
// `task-{shortId}` fallback when the workflow row no longer exists).
//
// Approach mirrors `migration-0002.test.ts`: stage A applies migrations
// 0000..0020, seeds tasks rows (some with deleted workflow), then stage B
// applies 0021 against the same file — the backfill UPDATE runs once and
// the seeded rows pick up their backfilled name.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { ulid } from 'ulid'
import * as schema from '../src/db/schema'

const ROOT_MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')
const JOURNAL_RAW = JSON.parse(readFileSync(join(ROOT_MIGRATIONS, 'meta', '_journal.json'), 'utf8'))

function makeMigrationsFolder(maxIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig-rfc037-'))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const subset = {
    version: JOURNAL_RAW.version,
    dialect: JOURNAL_RAW.dialect,
    entries: JOURNAL_RAW.entries.filter((e: { idx: number }) => e.idx <= maxIdx),
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(subset, null, 2))
  for (const e of subset.entries) {
    copyFileSync(join(ROOT_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    const snapName = `${String(e.idx).padStart(4, '0')}_snapshot.json`
    try {
      copyFileSync(join(ROOT_MIGRATIONS, 'meta', snapName), join(dir, 'meta', snapName))
    } catch {
      // snapshot file optional for migrate()
    }
  }
  return dir
}

function openWithMigrations(filePath: string, migrationsFolder: string) {
  const sqlite = new Database(filePath, { create: true })
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve(migrationsFolder) })
  return { db, sqlite }
}

interface SeededPre0021 {
  workflowKept: string
  workflowDropped: string
  taskKept: string
  taskOrphan: string
}

function seedPre0021(filePath: string, migrationsFolder: string): SeededPre0021 {
  const { sqlite } = openWithMigrations(filePath, migrationsFolder)
  try {
    const workflowKept = ulid()
    const workflowDropped = ulid()
    const now = Date.now()
    sqlite
      .prepare(
        `INSERT INTO workflows (id, name, description, definition, version, schema_version, created_at, updated_at)
         VALUES (?, 'code-review', '', '{}', 1, 1, ?, ?), (?, 'doomed-flow', '', '{}', 1, 1, ?, ?)`,
      )
      .run(workflowKept, now, now, workflowDropped, now, now)

    const taskKept = ulid()
    const taskOrphan = ulid()
    const insertTask = sqlite.prepare(
      `INSERT INTO tasks
         (id, workflow_id, workflow_snapshot, repo_path, worktree_path,
          base_branch, branch, base_commit, status, inputs, max_duration_ms,
          max_total_tokens, started_at, finished_at, error_summary, error_message,
          failed_node_id, expires_at, deleted_at, schema_version)
       VALUES (?, ?, '{}', '/r', '/wt', 'main', ?, NULL, 'done', '{}', NULL, NULL,
               1000, 2000, NULL, NULL, NULL, NULL, NULL, 1)`,
    )
    insertTask.run(taskKept, workflowKept, `agent-workflow/${taskKept}`)
    insertTask.run(taskOrphan, workflowDropped, `agent-workflow/${taskOrphan}`)

    // Simulate a historical task whose workflow row vanished while its
    // snapshot survived, so 0021 must exercise the fallback name.
    sqlite.exec('PRAGMA foreign_keys = OFF;')
    sqlite.prepare(`DELETE FROM workflows WHERE id = ?`).run(workflowDropped)
    sqlite.exec('PRAGMA foreign_keys = ON;')

    return { workflowKept, workflowDropped, taskKept, taskOrphan }
  } finally {
    sqlite.close()
  }
}

describe('RFC-037 migration 0021 — tasks.name + backfill', () => {
  const tmpDb = mkdtempSync(join(tmpdir(), 'aw-mig-rfc037-test-'))
  const dbPath = join(tmpDb, 'db.sqlite')
  let prevMigrationsDir: string
  let fullMigrationsDir: string
  let seeded: SeededPre0021

  beforeAll(() => {
    prevMigrationsDir = makeMigrationsFolder(19) // up to 0020
    fullMigrationsDir = makeMigrationsFolder(20) // up to 0021
  })

  // Every case builds the pre-0021 boundary itself. The old A → B → C test
  // chain only passed in declaration order and failed under --randomize.
  beforeEach(() => {
    rmSync(dbPath, { force: true })
    seeded = seedPre0021(dbPath, prevMigrationsDir)
  })

  afterAll(() => {
    rmSync(tmpDb, { recursive: true, force: true })
    rmSync(prevMigrationsDir, { recursive: true, force: true })
    rmSync(fullMigrationsDir, { recursive: true, force: true })
  })

  test('stage A: migrations 0000..0020 applied → tasks has no `name` column', () => {
    const { sqlite } = openWithMigrations(dbPath, prevMigrationsDir)
    try {
      const cols = sqlite.prepare("PRAGMA table_info('tasks')").all() as { name: string }[]
      expect(cols.map((c) => c.name)).not.toContain('name')
      const remaining = sqlite
        .prepare(`SELECT id FROM workflows WHERE id = ?`)
        .all(seeded.workflowDropped) as { id: string }[]
      expect(remaining.length).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  test('stage B: migration 0021 adds `name` and backfills both rows', () => {
    const { sqlite } = openWithMigrations(dbPath, fullMigrationsDir)
    try {
      const cols = sqlite.prepare("PRAGMA table_info('tasks')").all() as {
        name: string
        notnull: number
      }[]
      const nameCol = cols.find((c) => c.name === 'name')
      expect(nameCol).toBeDefined()

      const kept = sqlite.prepare(`SELECT name FROM tasks WHERE id = ?`).get(seeded.taskKept) as
        | { name: string }
        | undefined
      expect(kept?.name).toBe('code-review')

      const orphan = sqlite
        .prepare(`SELECT name FROM tasks WHERE id = ?`)
        .get(seeded.taskOrphan) as { name: string } | undefined
      // Fallback: 'task-' + last 10 chars of the ULID.
      expect(orphan?.name).toBe('task-' + seeded.taskOrphan.slice(-10))
      expect(orphan?.name.length).toBeGreaterThan(0)
    } finally {
      sqlite.close()
    }
  })

  test('stage C: re-opening idempotently re-applies nothing; backfill survives', () => {
    // Apply 0021 in this case before exercising the idempotent re-open. Do not
    // rely on stage B having happened first.
    openWithMigrations(dbPath, fullMigrationsDir).sqlite.close()
    const { sqlite } = openWithMigrations(dbPath, fullMigrationsDir)
    try {
      const rows = sqlite.prepare(`SELECT id, name FROM tasks ORDER BY id`).all() as {
        id: string
        name: string
      }[]
      const byId = new Map(rows.map((r) => [r.id, r.name]))
      expect(byId.get(seeded.taskKept)).toBe('code-review')
      expect(byId.get(seeded.taskOrphan)).toBe('task-' + seeded.taskOrphan.slice(-10))
    } finally {
      sqlite.close()
    }
  })
})
