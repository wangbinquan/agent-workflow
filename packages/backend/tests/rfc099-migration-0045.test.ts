import { rimrafDir } from './helpers/cleanup'
// RFC-099 T1 — locks migration 0045: the five resource tables gain
// owner_user_id + visibility, resource_grants is created, and the backfill
// assigns owner = earliest-created human admin (falling back to '__system__'
// on databases that never created one). Existing rows must come out
// visibility='public' so post-upgrade behavior is identical to pre-RFC-099
// (D2 zero-breakage).
//
// Approach mirrors migration-0021-task-name.test.ts: stage A applies
// migrations 0000..0044, seeds users + resources, then stage B applies 0045
// against the same file and asserts the backfill.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
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

const PREV_MAX_IDX = 43 // up to 0044
const FULL_MAX_IDX = 44 // up to 0045

function makeMigrationsFolder(maxIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig-rfc099-'))
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

function insertUser(
  sqlite: Database,
  args: { id: string; username: string; role: 'admin' | 'user'; createdAt: number },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, email, display_name, password_hash, role, status,
                          force_password_change, created_by, created_at, updated_at, last_login_at, schema_version)
       VALUES (?, ?, NULL, ?, NULL, ?, 'active', 0, NULL, ?, ?, NULL, 1)`,
    )
    .run(args.id, args.username, args.username, args.role, args.createdAt, args.createdAt)
}

function insertAgent(sqlite: Database, id: string, name: string): void {
  sqlite
    .prepare(`INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, 1000, 1000)`)
    .run(id, name)
}

function insertWorkflow(sqlite: Database, id: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO workflows (id, name, description, definition, version, schema_version, created_at, updated_at)
       VALUES (?, ?, '', '{}', 1, 1, 1000, 1000)`,
    )
    .run(id, name)
}

describe('RFC-099 migration 0045 — DB with human admins', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc099-mig-a-'))
  const dbPath = join(tmp, 'db.sqlite')
  let prevDir = ''
  let fullDir = ''
  const ids = { adminEarly: ulid(), adminLate: ulid(), user: ulid(), agent: ulid(), wf: ulid() }

  beforeAll(() => {
    prevDir = makeMigrationsFolder(PREV_MAX_IDX)
    fullDir = makeMigrationsFolder(FULL_MAX_IDX)
  })
  afterAll(() => {
    rimrafDir(tmp)
    rimrafDir(prevDir)
    rimrafDir(fullDir)
  })

  test('stage A: 0000..0044 — no ACL columns yet; seed 2 admins + 1 user + resources', () => {
    const { sqlite } = openWithMigrations(dbPath, prevDir)
    try {
      const cols = sqlite.prepare("PRAGMA table_info('agents')").all() as { name: string }[]
      expect(cols.map((c) => c.name)).not.toContain('owner_user_id')

      // adminLate is created FIRST in insertion order but with a LATER
      // created_at — the backfill must pick by created_at, not rowid.
      insertUser(sqlite, {
        id: ids.adminLate,
        username: 'late-admin',
        role: 'admin',
        createdAt: 2000,
      })
      insertUser(sqlite, {
        id: ids.adminEarly,
        username: 'early-admin',
        role: 'admin',
        createdAt: 1000,
      })
      insertUser(sqlite, { id: ids.user, username: 'bob', role: 'user', createdAt: 500 })
      insertAgent(sqlite, ids.agent, 'auditor')
      insertWorkflow(sqlite, ids.wf, 'code-review')
    } finally {
      sqlite.close()
    }
  })

  test('stage B: 0045 — owner backfilled to earliest admin; visibility public; grants table exists', () => {
    const { sqlite } = openWithMigrations(dbPath, fullDir)
    try {
      for (const [table, id] of [
        ['agents', ids.agent],
        ['workflows', ids.wf],
      ] as const) {
        const row = sqlite
          .prepare(`SELECT owner_user_id AS o, visibility AS v FROM ${table} WHERE id = ?`)
          .get(id) as { o: string; v: string }
        expect(row.o).toBe(ids.adminEarly)
        expect(row.v).toBe('public')
      }
      // skill_sources.created_by column exists (no rows to backfill here).
      const ssCols = sqlite.prepare("PRAGMA table_info('skill_sources')").all() as {
        name: string
      }[]
      expect(ssCols.map((c) => c.name)).toContain('created_by')
      // resource_grants exists with the composite PK shape.
      const grants = sqlite.prepare("PRAGMA table_info('resource_grants')").all() as {
        name: string
      }[]
      expect(grants.map((c) => c.name).sort()).toEqual(
        ['added_at', 'added_by', 'resource_id', 'resource_type', 'user_id'].sort(),
      )
      // Attribution columns landed.
      const rc = sqlite.prepare("PRAGMA table_info('review_comments')").all() as { name: string }[]
      expect(rc.map((c) => c.name)).toContain('author_role')
      const dv = sqlite.prepare("PRAGMA table_info('doc_versions')").all() as { name: string }[]
      expect(dv.map((c) => c.name)).toContain('decided_by_role')
      const cr = sqlite.prepare("PRAGMA table_info('clarify_rounds')").all() as { name: string }[]
      const crNames = cr.map((c) => c.name)
      expect(crNames).toContain('submitted_by_role')
      expect(crNames).toContain('answer_attributions_json')
      expect(crNames).toContain('draft_answers_json')
    } finally {
      sqlite.close()
    }
  })

  test('stage C: new rows after 0045 default to visibility=public with NULL owner until the app writes one', () => {
    const { sqlite } = openWithMigrations(dbPath, fullDir)
    try {
      const freshId = ulid()
      insertAgent(sqlite, freshId, 'fresh-agent')
      const row = sqlite
        .prepare(`SELECT owner_user_id AS o, visibility AS v FROM agents WHERE id = ?`)
        .get(freshId) as { o: string | null; v: string }
      expect(row.o).toBeNull() // backfill ran once at 0045 time, not per-insert
      expect(row.v).toBe('public')
    } finally {
      sqlite.close()
    }
  })
})

describe('RFC-099 migration 0045 — daemon-only DB (no human admin)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc099-mig-b-'))
  const dbPath = join(tmp, 'db.sqlite')
  let prevDir = ''
  let fullDir = ''
  const agentId = ulid()

  beforeAll(() => {
    prevDir = makeMigrationsFolder(PREV_MAX_IDX)
    fullDir = makeMigrationsFolder(FULL_MAX_IDX)
  })
  afterAll(() => {
    rimrafDir(tmp)
    rimrafDir(prevDir)
    rimrafDir(fullDir)
  })

  test('owner falls back to __system__ when no human admin exists', () => {
    {
      const { sqlite } = openWithMigrations(dbPath, prevDir)
      insertAgent(sqlite, agentId, 'lonely-agent')
      sqlite.close()
    }
    const { sqlite } = openWithMigrations(dbPath, fullDir)
    try {
      const row = sqlite
        .prepare(`SELECT owner_user_id AS o, visibility AS v FROM agents WHERE id = ?`)
        .get(agentId) as { o: string; v: string }
      expect(row.o).toBe('__system__')
      expect(row.v).toBe('public')
    } finally {
      sqlite.close()
    }
  })
})
