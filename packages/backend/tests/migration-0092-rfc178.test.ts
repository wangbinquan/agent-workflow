// RFC-178 — locks migration 0092 (drop external/parent-directory skills →
// managed-only).
//
// Two concerns:
//   1. At HEAD the migration DROPPED the external/source columns + the
//      skill_sources table (and its index), and KEPT the managed columns
//      (incl. migration_marker, retained for RFC-170's managed migrate op).
//   2. The reference-cleanup + row deletion is CORRECT: replay 0000..0091
//      (external columns still present), populate external + managed skills +
//      agents that reference them, then exec the real 0092 SQL and assert:
//        - agents.skills[] strips ONLY the deleted external names, keeping
//          managed names AND repo-local "project" names (DB has no row for them);
//        - source_kind='external' rows are gone;
//        - resource_grants for deleted external skills are cleaned, managed kept.
//      This is the first JSON-surgery migration (json_group_array), so the
//      correctness is exhaustively asserted here.
//
// If this reds, RFC-178 batch B is broken — the skills schema + agent-ref
// integrity depend on 0092 applying + stripping correctly.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function cols(db: DbClient, table: string): string[] {
  return (db.$client.query(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map(
    (c) => c.name,
  )
}
function tables(db: DbClient): string[] {
  return (
    db.$client.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
  ).map((t) => t.name)
}

describe('migration 0092 (RFC-178) — schema at HEAD', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('skills dropped the external/source columns; kept the managed columns', () => {
    const c = cols(db, 'skills')
    for (const gone of [
      'external_path',
      'source_id',
      'authority_kind',
      'source_state',
      'origin_source_id',
      'authority_owner_user_id',
    ]) {
      expect(c).not.toContain(gone)
    }
    for (const kept of [
      'managed_path',
      'migration_marker', // retained for RFC-170's managed migrate op
      'version_state',
      'reservation_state',
      'content_version',
      'meta_revision',
      'acl_revision',
    ]) {
      expect(c).toContain(kept)
    }
  })

  test('skill_sources table + skills_source_id_idx are gone', () => {
    expect(tables(db)).not.toContain('skill_sources')
    const idx = db.$client
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='skills_source_id_idx'")
      .all() as { name: string }[]
    expect(idx.length).toBe(0)
  })

  // NOTE: the DB `source_kind` CHECK is intentionally left as the superset
  // IN ('managed','external') — DROP COLUMN doesn't rebuild it, and tightening a
  // dead enum value via a full table rebuild isn't worth the risk (design §2/§4).
  // The TS `sourceKind` enum is narrowed to 'managed', and no code produces
  // 'external' anymore, so the wider DB CHECK is harmless.
})

// -----------------------------------------------------------------------------
// Reference cleanup: replay 0000..0091 (external columns present), populate
// legacy rows, then exec the real 0092 SQL and assert the strip + deletions.
// -----------------------------------------------------------------------------
describe('migration 0092 (RFC-178) — reference cleanup + row deletion (frozen at 0091)', () => {
  let tmp: string
  let sqlite: Database
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0092-'))
    // Copy the full tree, truncate the journal to idx<=90 (through 0091) so
    // migrate() stops before 0092 — external_path/source_id/skill_sources present.
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 90)
    writeFileSync(journalPath, JSON.stringify(journal))

    sqlite = new Database(':memory:')
    sqlite.exec('PRAGMA foreign_keys = OFF') // match openDb: 12-step migrations
    migrate(drizzle(sqlite), { migrationsFolder: tmp })
    raw = sqlite
  })
  afterEach(() => {
    sqlite?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function applyMigration0092() {
    const sql = readFileSync(
      join(MIGRATIONS, '0092_rfc178_remove_external_source_skills.sql'),
      'utf-8',
    )
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) raw.exec(trimmed)
    }
  }

  test('agent skill refs: external names stripped; managed + project (non-DB) names kept', () => {
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, owner_user_id) VALUES (?, 'extX', 'external', '/ext/x', 'u')",
      )
      .run(ulid())
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, managed_path, owner_user_id) VALUES (?, 'manY', 'managed', 'skills/manY/files', 'u')",
      )
      .run(ulid())
    // 'projZ' is a repo-local (self-discovered) name with NO DB row — must survive.
    raw
      .query('INSERT INTO agents (id, name, skills) VALUES (?, ?, ?)')
      .run(ulid(), 'a1', JSON.stringify(['extX', 'manY', 'projZ']))
    raw
      .query('INSERT INTO agents (id, name, skills) VALUES (?, ?, ?)')
      .run(ulid(), 'a2', JSON.stringify(['extX']))
    raw
      .query('INSERT INTO agents (id, name, skills) VALUES (?, ?, ?)')
      .run(ulid(), 'a3', JSON.stringify(['manY']))

    applyMigration0092()

    const skillsOf = (name: string) =>
      JSON.parse(
        (raw.query('SELECT skills FROM agents WHERE name = ?').get(name) as { skills: string })
          .skills,
      )
    expect(skillsOf('a1')).toEqual(['manY', 'projZ']) // extX stripped, project kept, order preserved
    expect(skillsOf('a2')).toEqual([]) // all-external → empty array (not NULL)
    expect(skillsOf('a3')).toEqual(['manY']) // no external ref → untouched

    const ext = raw
      .query("SELECT COUNT(*) AS n FROM skills WHERE source_kind = 'external'")
      .get() as { n: number }
    expect(ext.n).toBe(0)
    expect(
      (raw.query("SELECT COUNT(*) AS n FROM skills WHERE name = 'manY'").get() as { n: number }).n,
    ).toBe(1)
  })

  test('resource_grants: grants for deleted external skills cleaned, managed skill grants survive', () => {
    const extId = ulid()
    const manId = ulid()
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, owner_user_id, visibility) VALUES (?, 'extP', 'external', '/ext/p', 'u', 'private')",
      )
      .run(extId)
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, managed_path, owner_user_id, visibility) VALUES (?, 'manP', 'managed', 'skills/manP/files', 'u', 'private')",
      )
      .run(manId)
    raw
      .query(
        "INSERT INTO resource_grants (resource_type, resource_id, user_id, added_by, added_at) VALUES ('skill', ?, 'grantee', 'admin', 0)",
      )
      .run(extId)
    raw
      .query(
        "INSERT INTO resource_grants (resource_type, resource_id, user_id, added_by, added_at) VALUES ('skill', ?, 'grantee', 'admin', 0)",
      )
      .run(manId)

    applyMigration0092()

    const grantIds = (
      raw.query("SELECT resource_id FROM resource_grants WHERE resource_type = 'skill'").all() as {
        resource_id: string
      }[]
    ).map((r) => r.resource_id)
    expect(grantIds).not.toContain(extId) // deleted external skill's grant cleaned
    expect(grantIds).toContain(manId) // managed skill's grant survives
  })

  test('the full statement sequence applies + drops columns/table at the 0091→0092 boundary', () => {
    applyMigration0092()
    const skillCols = (raw.query("PRAGMA table_info('skills')").all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(skillCols).not.toContain('external_path')
    expect(skillCols).not.toContain('authority_kind')
    expect(skillCols).toContain('managed_path')
    const sources = raw
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_sources'")
      .all() as { name: string }[]
    expect(sources.length).toBe(0)
  })
})
