// RFC-170 T1 — locks migration 0090 (skills storage/ACL hardening schema).
//
// Two concerns:
//   1. The migration APPLIES cleanly (createInMemoryDb runs 0000..0090) and the
//      new columns/tables/defaults/constraints are present — schema shape +
//      CHECK (kind/active), partial-unique (one active op per skill), and the
//      skill_operation_locks PK exclusion.
//   2. The three backfill UPDATEs derive authority_kind / version_state /
//      authority_owner_user_id + degraded marking correctly from a real pre-0090
//      row population (replayed to idx 88 = through 0089, then 0090 applied).
//      A bug here would misclassify existing skills on upgrade (managed vs
//      source-external vs hand-external → wrong runtime injection + ACL).
//
// If this reds, RFC-170 §10 migration is broken — everything in batch B builds
// on these columns being present + correctly backfilled.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skillOperations } from '../src/db/schema'

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

describe('migration 0090 (RFC-170 skills storage/ACL) — schema + constraints', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('six ACL tables gained acl_revision (default 0)', () => {
    for (const t of ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups']) {
      expect(cols(db, t)).toContain('acl_revision')
    }
  })

  // RFC-178 (migration 0092) dropped authority_kind / source_state /
  // origin_source_id / authority_owner_user_id (external/source-only). 0090's
  // creation + backfill of those is still exercised in the "backfill derivation"
  // block below (frozen at 0090, so it never sees 0092). Here we lock only the
  // 0090 columns that SURVIVE at HEAD.
  test('skills gained the surviving identity/lifecycle columns', () => {
    const c = cols(db, 'skills')
    for (const col of ['meta_revision', 'migration_marker', 'reservation_state', 'version_state']) {
      expect(c).toContain(col)
    }
  })

  // RFC-178 (0092) dropped the skill_sources table entirely, so its 0090 columns
  // are no longer lockable at HEAD. fusions.precondition_token survives.
  test('fusions gained precondition_token', () => {
    expect(cols(db, 'fusions')).toContain('precondition_token')
  })

  test('skill_operations + skill_operation_locks tables exist', () => {
    const t = tables(db)
    expect(t).toContain('skill_operations')
    expect(t).toContain('skill_operation_locks')
  })

  test('skill_operations.kind CHECK rejects an unknown kind', () => {
    expect(() =>
      db.$client
        .query(
          "INSERT INTO skill_operations (op_id, skill_id, kind, phase) VALUES (?, ?, 'bogus', 'intent')",
        )
        .run(ulid(), ulid()),
    ).toThrow()
  })

  test('skill_operations partial-unique: two ACTIVE ops for one skill rejected, but active+inactive OK', () => {
    const skillId = ulid()
    db.insert(skillOperations)
      .values({ opId: ulid(), skillId, kind: 'delete', phase: 'intent' })
      .run()
    // Second active op on the same skill → violates uq_skill_operations_active.
    expect(() =>
      db
        .insert(skillOperations)
        .values({ opId: ulid(), skillId, kind: 'version-write', phase: 'intent' })
        .run(),
    ).toThrow()
    // An INACTIVE (active=0) row for the same skill is allowed (retry_index style).
    db.insert(skillOperations)
      .values({ opId: ulid(), skillId, kind: 'version-write', phase: 'done', active: 0 })
      .run()
    const rows = db.$client
      .query('SELECT COUNT(*) AS n FROM skill_operations WHERE skill_id = ?')
      .get(skillId) as { n: number }
    expect(rows.n).toBe(2)
  })

  test('skill_operation_locks PK: two locks for one skillId rejected (universal exclusion)', () => {
    const skillId = ulid()
    db.$client
      .query('INSERT INTO skill_operation_locks (locked_skill_id, op_id) VALUES (?, ?)')
      .run(skillId, ulid())
    expect(() =>
      db.$client
        .query('INSERT INTO skill_operation_locks (locked_skill_id, op_id) VALUES (?, ?)')
        .run(skillId, ulid()),
    ).toThrow()
  })
})

// -----------------------------------------------------------------------------
// Backfill: replay 0000..0089 into a temp folder (truncated journal), populate
// legacy rows, then exec the real 0090 SQL and assert the derived columns.
// -----------------------------------------------------------------------------
describe('migration 0090 (RFC-170) — backfill derivation', () => {
  let tmp: string
  let sqlite: Database
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0090-'))
    // Copy the full migrations tree, then truncate the journal to the first 89
    // entries (idx 0..88 = through 0089) so migrate() stops before 0090.
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 88)
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

  function applyMigration0090() {
    const sql = readFileSync(join(MIGRATIONS, '0090_rfc170_skills_storage_acl.sql'), 'utf-8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) raw.exec(trimmed)
    }
  }

  test('authority_kind: managed / source-external / hand-external derived from source_kind + source_id', () => {
    const srcId = ulid()
    raw
      .query(
        "INSERT INTO skill_sources (id, path, label, created_by) VALUES (?, '/ext/src', 'src', 'userA')",
      )
      .run(srcId)
    // managed
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, managed_path, owner_user_id) VALUES (?, 'm1', 'managed', 'skills/m1/files', 'userA')",
      )
      .run(ulid())
    // source-external (owner matches registrar → not degraded)
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, source_id, owner_user_id) VALUES (?, 's1', 'external', '/ext/src/s1', ?, 'userA')",
      )
      .run(ulid(), srcId)
    // hand-external (external, no source_id)
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, owner_user_id) VALUES (?, 'h1', 'external', '/home/u/h1', 'userB')",
      )
      .run(ulid())

    applyMigration0090()

    const get = (name: string) =>
      raw
        .query(
          'SELECT authority_kind, version_state, authority_owner_user_id, source_state FROM skills WHERE name = ?',
        )
        .get(name) as {
        authority_kind: string
        version_state: string
        authority_owner_user_id: string | null
        source_state: string | null
      }
    expect(get('m1').authority_kind).toBe('managed')
    expect(get('s1').authority_kind).toBe('source-external')
    expect(get('h1').authority_kind).toBe('hand-external')
  })

  test('version_state: managed WITH a skill_versions row → snapshot-unverified; without → legacy-unbackfilled', () => {
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, managed_path, owner_user_id) VALUES (?, 'withv', 'managed', 'skills/withv/files', 'u')",
      )
      .run(ulid())
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, managed_path, owner_user_id) VALUES (?, 'nov', 'managed', 'skills/nov/files', 'u')",
      )
      .run(ulid())
    raw
      .query(
        "INSERT INTO skill_versions (id, skill_name, version_index, files_path, source) VALUES (?, 'withv', 1, 'skills/withv/versions/v1/files', 'initial')",
      )
      .run(ulid())

    applyMigration0090()

    const vs = (name: string) =>
      (
        raw.query('SELECT version_state FROM skills WHERE name = ?').get(name) as {
          version_state: string
        }
      ).version_state
    expect(vs('withv')).toBe('snapshot-unverified')
    expect(vs('nov')).toBe('legacy-unbackfilled')
  })

  test('provenance backfill: source-external ← registrar; hand-external → NULL + degraded; source-external owner-mismatch → degraded', () => {
    const srcId = ulid()
    raw
      .query(
        "INSERT INTO skill_sources (id, path, label, created_by) VALUES (?, '/ext/s', 's', 'registrar')",
      )
      .run(srcId)
    // source-external, owner == registrar → provenance=registrar, not degraded
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, source_id, owner_user_id) VALUES (?, 'ok', 'external', '/ext/s/ok', ?, 'registrar')",
      )
      .run(ulid(), srcId)
    // source-external, owner != registrar (pre-upgrade transfer) → degraded
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, source_id, owner_user_id) VALUES (?, 'drift', 'external', '/ext/s/drift', ?, 'transferee')",
      )
      .run(ulid(), srcId)
    // hand-external → provenance NULL + degraded (can't prove content controller)
    raw
      .query(
        "INSERT INTO skills (id, name, source_kind, external_path, owner_user_id) VALUES (?, 'hand', 'external', '/home/hand', 'someone')",
      )
      .run(ulid())

    applyMigration0090()

    const row = (name: string) =>
      raw
        .query('SELECT authority_owner_user_id, source_state FROM skills WHERE name = ?')
        .get(name) as { authority_owner_user_id: string | null; source_state: string | null }
    expect(row('ok')).toEqual({ authority_owner_user_id: 'registrar', source_state: null })
    expect(row('drift').source_state).toBe('degraded')
    expect(row('hand')).toEqual({ authority_owner_user_id: null, source_state: 'degraded' })
  })
})
