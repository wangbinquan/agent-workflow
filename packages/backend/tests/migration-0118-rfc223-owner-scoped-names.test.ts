import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

const OWNER_SCOPED_TABLES = ['agents', 'skills', 'mcps', 'plugins', 'workgroups'] as const

function freezeThrough0117(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc223-0118-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 116)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

function insertResource(
  raw: Database,
  table: (typeof OWNER_SCOPED_TABLES)[number],
  id: string,
  name: string,
  ownerUserId: string | null,
): void {
  const owner = ownerUserId === null ? 'NULL' : `'${ownerUserId}'`
  switch (table) {
    case 'agents':
      raw.exec(`INSERT INTO agents (id, name, owner_user_id) VALUES ('${id}', '${name}', ${owner})`)
      return
    case 'skills':
      raw.exec(
        `INSERT INTO skills (id, name, source_kind, owner_user_id)
         VALUES ('${id}', '${name}', 'managed', ${owner})`,
      )
      return
    case 'mcps':
      raw.exec(
        `INSERT INTO mcps (id, name, type, owner_user_id)
         VALUES ('${id}', '${name}', 'local', ${owner})`,
      )
      return
    case 'plugins':
      raw.exec(
        `INSERT INTO plugins (
           id, name, spec, source_kind, cached_path, installed_at, owner_user_id
         ) VALUES (
           '${id}', '${name}', 'pkg', 'npm', '/tmp/${id}', 1, ${owner}
         )`,
      )
      return
    case 'workgroups':
      raw.exec(
        `INSERT INTO workgroups (id, name, owner_user_id) VALUES ('${id}', '${name}', ${owner})`,
      )
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0118 RFC-223 owner-scoped resource names', () => {
  test('backfills legacy NULL owners and installs the five expression unique indexes', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0117() })

    for (const table of OWNER_SCOPED_TABLES) {
      insertResource(raw, table, `${table}-legacy`, `${table}-legacy-name`, null)
    }

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    for (const table of OWNER_SCOPED_TABLES) {
      expect(
        raw
          .query(`SELECT owner_user_id AS ownerUserId FROM ${table} WHERE id = ?`)
          .get(`${table}-legacy`),
      ).toEqual({ ownerUserId: '__system__' })

      const oldIndex = `${table}_name_unique`
      const newIndex = `${table}_owner_name_unique`
      const indexes = raw.query(`PRAGMA index_list('${table}')`).all() as Array<{
        name: string
        unique: number
      }>
      expect(indexes.find((index) => index.name === oldIndex)).toBeUndefined()
      expect(indexes.find((index) => index.name === newIndex)?.unique).toBe(1)

      const parts = raw.query(`PRAGMA index_xinfo('${newIndex}')`).all() as Array<{
        cid: number
        name: string | null
        key: number
      }>
      expect(parts.filter((part) => part.key === 1).map((part) => [part.cid, part.name])).toEqual([
        [-2, null],
        [1, 'name'],
      ])
      const ddl = raw
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(newIndex) as { sql: string }
      expect(ddl.sql).toContain("COALESCE(`owner_user_id`, '')")
    }

    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  test('allows cross-owner duplicates but rejects same-owner and NULL-bucket duplicates', () => {
    const raw = new Database(':memory:')
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    for (const table of OWNER_SCOPED_TABLES) {
      insertResource(raw, table, `${table}-a`, 'shared-label', 'owner-a')
      insertResource(raw, table, `${table}-b`, 'shared-label', 'owner-b')
      expect(() => insertResource(raw, table, `${table}-a2`, 'shared-label', 'owner-a')).toThrow()

      insertResource(raw, table, `${table}-null-a`, 'null-label', null)
      expect(() => insertResource(raw, table, `${table}-null-b`, 'null-label', null)).toThrow()
    }

    raw.exec(`
      INSERT INTO workflows (id, name, definition, owner_user_id)
      VALUES
        ('workflow-a', 'shared-workflow', '{}', 'owner-a'),
        ('workflow-b', 'shared-workflow', '{}', 'owner-a');
      INSERT INTO runtimes (id, name, protocol)
      VALUES ('runtime-a', 'shared-runtime', 'opencode');
    `)
    expect(() =>
      raw.exec(
        "INSERT INTO runtimes (id, name, protocol) VALUES ('runtime-b', 'shared-runtime', 'opencode')",
      ),
    ).toThrow()
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
