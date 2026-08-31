import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { openSqliteLogicalSourceWorker } from '@/platform/persistence/sqliteLogicalSourceWorkerSupervisor'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

function fixturePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-source-'))
  roots.push(root)
  const path = join(root, 'db.sqlite')
  const drizzle = createInMemoryDb(MIGRATIONS)
  const sqlite = (drizzle as unknown as { $client: Database }).$client
  sqlite.exec(
    "INSERT INTO users (id, username, display_name, role, status, force_password_change, created_at, updated_at, schema_version, access_revision, git_name) VALUES ('usr-2', 'bravo', 'Bravo', 'user', 'active', 0, 9007199254740993, 2, 1, 0, ''), ('usr-1', 'alpha', 'Alpha', 'user', 'active', 1, 1, 2, 1, 0, '')",
  )
  writeFileSync(path, sqlite.serialize())
  sqlite.close()
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 SQLite logical source', () => {
  test('preflights all 184 tables and paginates with lossless migration keys', async () => {
    const contract = buildLogicalSchemaContract()
    const path = fixturePath()
    const source = openSqliteLogicalSource({ path, contract })
    try {
      const snapshot = await source.preflight()
      expect(Object.keys(snapshot.tableRows)).toHaveLength(184)
      expect(snapshot.tableRows.users).toBeGreaterThanOrEqual(2)
      const table = contract.tables.find((candidate) => candidate.id === 'users')!
      const rows = await source.readChunk(table, null, 10)
      const first = rows.find((row) => row.key[0]?.type === 'text' && row.key[0].value === 'usr-1')!
      const second = (await source.readChunk(table, first.key, 10)).find(
        (row) => row.key[0]?.type === 'text' && row.key[0].value === 'usr-2',
      )!
      expect(first.key).toEqual([{ type: 'text', value: 'usr-1' }])
      expect(second.key).toEqual([{ type: 'text', value: 'usr-2' }])
      const createdAtIndex = table.columns.findIndex((column) => column.name === 'created_at')
      expect(second.values[createdAtIndex]).toEqual({
        type: 'integer',
        value: '9007199254740993',
      })
      await source.assertUnchanged(snapshot)
    } finally {
      await source.close()
    }
  })

  test('fails the generation fence after an external source write', async () => {
    const contract = buildLogicalSchemaContract()
    const path = fixturePath()
    const source = openSqliteLogicalSource({ path, contract })
    try {
      const snapshot = await source.preflight()
      const writer = new Database(path)
      writer.exec("UPDATE users SET display_name = 'Changed' WHERE id = 'usr-1'")
      writer.close()
      await expect(source.assertUnchanged(snapshot)).rejects.toThrow(
        'changed after the migration freeze',
      )
    } finally {
      await source.close()
    }
  })

  test('runs the production 184-table source scan and chunk reads through a Worker', async () => {
    const contract = buildLogicalSchemaContract()
    const path = fixturePath()
    const source = await openSqliteLogicalSourceWorker({ path, contract })
    try {
      const snapshot = await source.preflight()
      expect(Object.keys(snapshot.tableRows)).toHaveLength(184)
      const table = contract.tables.find((candidate) => candidate.id === 'users')!
      const rows = await source.readChunk(table, null, 1)
      expect(rows).toHaveLength(1)
      await source.assertUnchanged(snapshot)
    } finally {
      await source.close()
    }
  })
})
