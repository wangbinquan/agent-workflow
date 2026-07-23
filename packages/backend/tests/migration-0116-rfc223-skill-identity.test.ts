// RFC-223 PR-5 — real upgrade proof for the only table rebuild in the RFC.
//
// Freeze at 0115, seed name-keyed skill_versions, execute the shipped 0116 SQL,
// and prove lossless metadata preservation plus the new immutable-id FK/unique
// contract. An orphan fixture must stop at the guard with the legacy table and
// row still intact; INNER JOIN must never become a silent data-loss filter.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface VersionFixture {
  id: string
  skillName: string
  versionIndex: number
  filesPath: string
  source: string
  summary: string | null
  fusionId: string | null
  restoredFromVersion: number | null
  authorUserId: string | null
  contentHash: string | null
  createdAt: number
}

describe('migration 0116 (RFC-223 PR-5) — fresh replay', () => {
  test('fresh install exposes skill_id with the final FK and indexes', () => {
    const db = createInMemoryDb(MIGRATIONS)
    assertFinalShape(db.$client)
    expect(db.$client.query("PRAGMA foreign_key_check('skill_versions')").all()).toEqual([])
  })
})

describe('migration 0116 (RFC-223 PR-5) — frozen 0115 upgrade', () => {
  let tmp: string
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0116-'))
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 114)
    writeFileSync(journalPath, JSON.stringify(journal))

    raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = OFF')
    migrate(drizzle(raw), { migrationsFolder: tmp })
  })

  afterEach(() => {
    raw?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('preserves every row/metadata field and rewires identity to skills.id', () => {
    insertSkill(raw, 'skill-id-a', 'alpha')
    insertSkill(raw, 'skill-id-b', 'beta')
    const fixtures: VersionFixture[] = [
      {
        id: 'version-a1',
        skillName: 'alpha',
        versionIndex: 1,
        filesPath: 'skills/alpha/versions/v1/files',
        source: 'initial',
        summary: 'first',
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: 'user-a',
        contentHash: 'hash-a1',
        createdAt: 101,
      },
      {
        id: 'version-a2',
        skillName: 'alpha',
        versionIndex: 2,
        filesPath: 'skills/alpha/versions/v2/files',
        source: 'fusion',
        summary: null,
        fusionId: 'fusion-a',
        restoredFromVersion: 1,
        authorUserId: null,
        contentHash: null,
        createdAt: 102,
      },
      {
        id: 'version-b1',
        skillName: 'beta',
        versionIndex: 1,
        filesPath: 'skills/beta/versions/v1/files',
        source: 'restore',
        summary: 'restored',
        fusionId: null,
        restoredFromVersion: 3,
        authorUserId: 'user-b',
        contentHash: 'hash-b1',
        createdAt: 103,
      },
    ]
    for (const fixture of fixtures) insertLegacyVersion(raw, fixture)
    const before = countVersions(raw)

    apply0116WithMigrator(raw, tmp)

    expect(countVersions(raw)).toBe(before)
    expect(migrationCount(raw)).toBe(116)
    const rows = raw
      .query(
        `SELECT id, skill_id AS skillId, version_index AS versionIndex,
                files_path AS filesPath, source, summary, fusion_id AS fusionId,
                restored_from_version AS restoredFromVersion,
                author_user_id AS authorUserId, content_hash AS contentHash,
                created_at AS createdAt
         FROM skill_versions ORDER BY id`,
      )
      .all() as Array<Omit<VersionFixture, 'skillName'> & { skillId: string }>
    expect(rows).toEqual([
      {
        id: 'version-a1',
        skillId: 'skill-id-a',
        versionIndex: 1,
        filesPath: 'skills/alpha/versions/v1/files',
        source: 'initial',
        summary: 'first',
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: 'user-a',
        contentHash: 'hash-a1',
        createdAt: 101,
      },
      {
        id: 'version-a2',
        skillId: 'skill-id-a',
        versionIndex: 2,
        filesPath: 'skills/alpha/versions/v2/files',
        source: 'fusion',
        summary: null,
        fusionId: 'fusion-a',
        restoredFromVersion: 1,
        authorUserId: null,
        contentHash: null,
        createdAt: 102,
      },
      {
        id: 'version-b1',
        skillId: 'skill-id-b',
        versionIndex: 1,
        filesPath: 'skills/beta/versions/v1/files',
        source: 'restore',
        summary: 'restored',
        fusionId: null,
        restoredFromVersion: 3,
        authorUserId: 'user-b',
        contentHash: 'hash-b1',
        createdAt: 103,
      },
    ])
    assertFinalShape(raw)
    expect(raw.query("PRAGMA foreign_key_check('skill_versions')").all()).toEqual([])

    expect(() =>
      raw
        .query(
          `INSERT INTO skill_versions
             (id, skill_id, version_index, files_path, source)
           VALUES ('duplicate', 'skill-id-a', 1, 'x', 'editor')`,
        )
        .run(),
    ).toThrow(/UNIQUE/)
    expect(() =>
      raw
        .query(
          `INSERT INTO skill_versions
             (id, skill_id, version_index, files_path, source)
           VALUES ('orphan', 'missing-id', 1, 'x', 'editor')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)

    raw.query("DELETE FROM skills WHERE id = 'skill-id-b'").run()
    expect(raw.query("SELECT id FROM skill_versions WHERE skill_id = 'skill-id-b'").all()).toEqual(
      [],
    )
  })

  test('orphan guard refuses before rebuild and leaves the legacy row/table intact', () => {
    insertSkill(raw, 'skill-id-a', 'alpha')
    insertLegacyVersion(raw, {
      id: 'orphan-version',
      skillName: 'missing-name',
      versionIndex: 1,
      filesPath: 'skills/missing-name/versions/v1/files',
      source: 'initial',
      summary: null,
      fusionId: null,
      restoredFromVersion: null,
      authorUserId: null,
      contentHash: 'orphan-hash',
      createdAt: 201,
    })

    const beforeMigrations = migrationCount(raw)
    expect(() => apply0116WithMigrator(raw, tmp)).toThrow(
      /Failed to run the query|CHECK constraint failed/,
    )
    expect(migrationCount(raw)).toBe(beforeMigrations)
    const columns = columnNames(raw)
    expect(columns).toContain('skill_name')
    expect(columns).not.toContain('skill_id')
    expect(raw.query('SELECT id, skill_name AS skillName FROM skill_versions').all()).toEqual([
      { id: 'orphan-version', skillName: 'missing-name' },
    ])

    raw.query("DELETE FROM skill_versions WHERE id = 'orphan-version'").run()
    apply0116WithMigrator(raw, tmp)
    expect(migrationCount(raw)).toBe(beforeMigrations + 1)
    assertFinalShape(raw)
  })
})

function apply0116WithMigrator(raw: Database, folder: string): void {
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json')),
  )
  raw.exec('PRAGMA foreign_keys = OFF')
  migrate(drizzle(raw), { migrationsFolder: folder })
  raw.exec('PRAGMA foreign_keys = ON')
}

function insertSkill(raw: Database, id: string, name: string): void {
  raw
    .query(
      `INSERT INTO skills (id, name, source_kind, managed_path)
       VALUES (?, ?, 'managed', ?)`,
    )
    .run(id, name, `skills/${name}/files`)
}

function insertLegacyVersion(raw: Database, row: VersionFixture): void {
  raw
    .query(
      `INSERT INTO skill_versions
         (id, skill_name, version_index, files_path, source, summary, fusion_id,
          restored_from_version, author_user_id, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.skillName,
      row.versionIndex,
      row.filesPath,
      row.source,
      row.summary,
      row.fusionId,
      row.restoredFromVersion,
      row.authorUserId,
      row.contentHash,
      row.createdAt,
    )
}

function countVersions(raw: Database): number {
  return (raw.query('SELECT COUNT(*) AS n FROM skill_versions').get() as { n: number }).n
}

function migrationCount(raw: Database): number {
  return (
    raw.query('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
      n: number
    }
  ).n
}

function columnNames(raw: Database): string[] {
  return (
    raw.query("SELECT name FROM pragma_table_info('skill_versions')").all() as {
      name: string
    }[]
  ).map((row) => row.name)
}

function assertFinalShape(raw: Database): void {
  expect(columnNames(raw)).toContain('skill_id')
  expect(columnNames(raw)).not.toContain('skill_name')
  expect(raw.query("PRAGMA foreign_key_list('skill_versions')").all()).toEqual([
    expect.objectContaining({
      table: 'skills',
      from: 'skill_id',
      to: 'id',
      on_delete: 'CASCADE',
    }),
  ])
  const indexes = raw.query("PRAGMA index_list('skill_versions')").all() as Array<{
    name: string
    unique: number
  }>
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'uq_skill_versions_skill_v', unique: 1 }),
      expect.objectContaining({ name: 'idx_skill_versions_created', unique: 0 }),
    ]),
  )
  expect(raw.query("PRAGMA index_info('uq_skill_versions_skill_v')").all()).toEqual([
    expect.objectContaining({ seqno: 0, name: 'skill_id' }),
    expect.objectContaining({ seqno: 1, name: 'version_index' }),
  ])
  expect(raw.query("PRAGMA index_info('idx_skill_versions_created')").all()).toEqual([
    expect.objectContaining({ seqno: 0, name: 'created_at' }),
  ])
}
