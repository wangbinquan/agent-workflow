import { rimrafDir } from './helpers/cleanup'
// Locks in RFC-005 PR-A T2: the 0002 migration adds doc_versions +
// review_comments + node_runs.review_iteration, and existing v1 task + node_run
// rows survive intact. If this goes red, check
//   packages/backend/db/migrations/0002_melted_stryfe.sql
//   packages/backend/src/db/schema.ts
// in lock-step.
//
// Approach: file-backed SQLite, two-stage migration.
//   1. Stage A: write a migrations folder containing only 0000 + 0001 (and a
//      truncated _journal.json), openDb against it. drizzle applies 0000+0001
//      to the file.
//   2. Seed deterministic rows in tasks + node_runs.
//   3. Stage B: write a full migrations folder (0000+0001+0002 + full journal),
//      openDb again on the SAME file. drizzle sees the existing
//      __drizzle_migrations hashes for 0000+0001 and applies only 0002.
//   4. Verify seed rows preserved + new schema reachable.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { ulid } from 'ulid'
import * as schema from '../src/db/schema'
import { nodeRuns, tasks } from '../src/db/schema'

const ROOT_MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')
const JOURNAL_RAW = JSON.parse(readFileSync(join(ROOT_MIGRATIONS, 'meta', '_journal.json'), 'utf8'))

function makeMigrationsFolder(entries: number[]): string {
  // entries is a list of journal idx values to include, e.g. [0,1] for v1-only.
  const dir = mkdtempSync(join(tmpdir(), 'aw-migration-'))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const subsetJournal = {
    version: JOURNAL_RAW.version,
    dialect: JOURNAL_RAW.dialect,
    entries: JOURNAL_RAW.entries.filter((e: { idx: number }) => entries.includes(e.idx)),
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(subsetJournal, null, 2))
  // Copy referenced snapshot files (drizzle migrator also reads meta/{tag}.snapshot.json).
  for (const e of subsetJournal.entries) {
    const sqlSrc = join(ROOT_MIGRATIONS, `${e.tag}.sql`)
    const sqlDst = join(dir, `${e.tag}.sql`)
    copyFileSync(sqlSrc, sqlDst)
    const snapSrc = join(ROOT_MIGRATIONS, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`)
    const snapDst = join(dir, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`)
    try {
      copyFileSync(snapSrc, snapDst)
    } catch {
      // older drizzle snapshots may be absent; non-fatal for migrate()
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

describe('RFC-005 0002 migration — data integrity + new schema', () => {
  const tmpDb = mkdtempSync(join(tmpdir(), 'aw-mig-test-'))
  const dbPath = join(tmpDb, 'db.sqlite')
  let v1MigrationsDir: string
  let v2MigrationsDir: string

  beforeAll(() => {
    v1MigrationsDir = makeMigrationsFolder([0, 1])
    v2MigrationsDir = makeMigrationsFolder([0, 1, 2])
  })

  afterAll(() => {
    rimrafDir(tmpDb)
    rimrafDir(v1MigrationsDir)
    rimrafDir(v2MigrationsDir)
  })

  test('stage A: applies 0000 + 0001 only; v1 schema is reachable', () => {
    const { sqlite } = openWithMigrations(dbPath, v1MigrationsDir)

    // Seed a workflow + task + node_run, the way the daemon would after v1.
    const workflowId = ulid()
    // RFC-099 update: switched from drizzle's typed insert to raw SQL for the
    // same reason tasks/node_runs below already did (RFC-024 comment) — adding
    // `visibility` (RFC-099, default 'public') to schema.ts makes drizzle emit
    // `INSERT (..., visibility)` against a v1 DB that doesn't have the column.
    sqlite
      .prepare(
        `INSERT INTO workflows (id, name, description, definition, version, schema_version, created_at, updated_at)
         VALUES (?, 'design-flow', '', ?, 1, 1, ?, ?)`,
      )
      .run(
        workflowId,
        JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
        Date.now(),
        Date.now(),
      )

    const taskId = ulid()
    // RFC-024 update: switched from drizzle's typed insert to raw SQL for the
    // same reason node_runs already does (see comment below). Adding `repoUrl`
    // (RFC-024) to schema.ts would make drizzle emit `INSERT (..., repo_url)`
    // against a v1 DB that doesn't yet have the column. Raw SQL pins the test
    // to the columns 0000+0001 actually created.
    sqlite
      .prepare(
        `INSERT INTO tasks
          (id, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, base_commit, status, inputs, max_duration_ms,
           max_total_tokens, started_at, finished_at, error_summary,
           error_message, failed_node_id, expires_at, deleted_at, schema_version)
         VALUES (?, ?, ?, '/repo', '/wt', 'main', ?, NULL, 'done',
                 ?, NULL, NULL, 1000, 2000, NULL, NULL, NULL, NULL, NULL, 1)`,
      )
      .run(
        taskId,
        workflowId,
        JSON.stringify({ $schema_version: 1 }),
        'agent-workflow/' + taskId,
        JSON.stringify({ requirement: 'do thing' }),
      )

    const nodeRunId = ulid()
    // NB: review_iteration column does not exist yet in stage A — drizzle
    // INSERT still works because the schema.ts defines a default(0), and the
    // SQL column also doesn't exist; drizzle just emits column names that DO
    // exist. We sidestep this by using raw SQL so the seed survives the
    // schema-vs-DB version mismatch.
    sqlite
      .prepare(
        `INSERT INTO node_runs
          (id, task_id, node_id, parent_node_run_id, iteration, shard_key,
           retry_index, status, started_at, finished_at, pid, exit_code,
           error_message, prompt_text, tok_input, tok_output, tok_cache_create,
           tok_cache_read, tok_total, pre_snapshot)
         VALUES (?, ?, ?, NULL, 0, NULL, 0, 'done', 1000, 2000, NULL, 0,
                 NULL, NULL, 10, 20, 0, 0, 30, NULL)`,
      )
      .run(nodeRunId, taskId, 'designer')

    // Verify stage A is genuinely pre-0002: doc_versions table does not exist.
    const tablesBefore = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const namesBefore = tablesBefore.map((r) => r.name)
    expect(namesBefore).not.toContain('doc_versions')
    expect(namesBefore).not.toContain('review_comments')
    // node_runs exists but has no review_iteration column.
    const cols = sqlite.prepare("PRAGMA table_info('node_runs')").all() as { name: string }[]
    expect(cols.map((c) => c.name)).not.toContain('review_iteration')

    sqlite.close()
    // Hand the ULIDs off to stage B through module scope.
    seededIds.workflowId = workflowId
    seededIds.taskId = taskId
    seededIds.nodeRunId = nodeRunId
  })

  test('stage B: applies 0002; v1 rows untouched, new schema present', () => {
    const { db, sqlite } = openWithMigrations(dbPath, v2MigrationsDir)

    // 1. node_runs.review_iteration column exists, default 0.
    const cols = sqlite.prepare("PRAGMA table_info('node_runs')").all() as {
      name: string
      dflt_value: string | null
    }[]
    const rev = cols.find((c) => c.name === 'review_iteration')
    expect(rev).toBeDefined()
    expect(rev?.dflt_value).toBe('0')

    // 2. doc_versions + review_comments tables exist.
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((r) => r.name)
    expect(names).toContain('doc_versions')
    expect(names).toContain('review_comments')

    // 3. Indexes exist.
    const idxs = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[]
    const idxNames = idxs.map((r) => r.name)
    expect(idxNames).toContain('idx_doc_versions_review_run')
    expect(idxNames).toContain('idx_doc_versions_task')
    expect(idxNames).toContain('idx_review_comments_version')

    // 4. v1 seed rows preserved.
    const t = db.select().from(tasks).where(eq(tasks.id, seededIds.taskId)).all()
    expect(t.length).toBe(1)
    expect(t[0]?.status).toBe('done')
    expect(t[0]?.workflowId).toBe(seededIds.workflowId)

    const nr = db.select().from(nodeRuns).where(eq(nodeRuns.id, seededIds.nodeRunId)).all()
    expect(nr.length).toBe(1)
    // Existing v1 row picks up the new column at default 0.
    expect(nr[0]?.reviewIteration).toBe(0)
    expect(nr[0]?.status).toBe('done')

    // 5. Can insert into doc_versions + review_comments.
    //
    // NOTE: raw SQL on purpose — same reason as the v1 seed above. Future
    // migrations (e.g. 0003 added `source_file_path`) introduce new columns
    // in `schema.ts`. Drizzle's typed insert lists every schema-known column
    // in the SQL, but the DB at this stage only has the 0002 schema. Raw
    // INSERT lets us touch only the columns 0002 actually created, so this
    // test stays a true 0002-boundary check across future schema bumps.
    const docVersionId = ulid()
    sqlite
      .prepare(
        `INSERT INTO doc_versions
          (id, task_id, review_node_id, review_node_run_id, source_node_id,
           source_port_name, version_index, review_iteration, body_path,
           comments_json, decision, decision_reason, prompt_snapshot,
           agent_snapshot, decided_at, decided_by)
         VALUES (?, ?, 'rev_1', ?, 'designer', 'design', 1, 0,
                 'runs/x/review/rev_1/design/v1.md', '[]', 'pending',
                 NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(docVersionId, seededIds.taskId, seededIds.nodeRunId)
    const dvRows = sqlite
      .prepare(
        `SELECT id, version_index, decision, comments_json
         FROM doc_versions WHERE id = ?`,
      )
      .all(docVersionId) as {
      id: string
      version_index: number
      decision: string
      comments_json: string
    }[]
    expect(dvRows.length).toBe(1)
    expect(dvRows[0]?.version_index).toBe(1)
    expect(dvRows[0]?.decision).toBe('pending')
    expect(dvRows[0]?.comments_json).toBe('[]')

    const commentId = ulid()
    sqlite
      .prepare(
        `INSERT INTO review_comments
          (id, doc_version_id, anchor_section_path, anchor_paragraph_idx,
           anchor_offset_start, anchor_offset_end, selected_text,
           context_before, context_after, occurrence_index, comment_text)
         VALUES (?, ?, '## Design', 0, 0, 5, 'hello', '', '', 1, 'looks wrong')`,
      )
      .run(commentId, docVersionId)
    const cRows = sqlite
      .prepare(`SELECT id, comment_text, author FROM review_comments WHERE id = ?`)
      .all(commentId) as { id: string; comment_text: string; author: string }[]
    expect(cRows.length).toBe(1)
    expect(cRows[0]?.comment_text).toBe('looks wrong')
    expect(cRows[0]?.author).toBe('local') // default

    // 6. FK cascade: delete the docVersion → review_comments row gone.
    sqlite.prepare(`DELETE FROM doc_versions WHERE id = ?`).run(docVersionId)
    const cAfter = sqlite.prepare(`SELECT id FROM review_comments WHERE id = ?`).all(commentId) as {
      id: string
    }[]
    expect(cAfter.length).toBe(0)

    sqlite.close()
  })

  test('stage C: re-opening the file is idempotent — no migrations re-run', () => {
    // openWithMigrations should run cleanly without throwing on a fully-migrated file.
    const { db, sqlite } = openWithMigrations(dbPath, v2MigrationsDir)
    // The seed rows survive across re-opens.
    const t = db.select().from(tasks).where(eq(tasks.id, seededIds.taskId)).all()
    expect(t.length).toBe(1)
    sqlite.close()
  })
})

// Module-scoped seed identifiers passed between stages.
const seededIds = { workflowId: '', taskId: '', nodeRunId: '' }
