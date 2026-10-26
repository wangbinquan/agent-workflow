// AF-D21: schema admission now proves native epoch-2 history and physical catalogs.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { SchemaHistoryError } from '@/platform/persistence/schema/history/types'
const roots: string[] = []
const path = () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc275-epoch2-'))
  roots.push(root)
  return join(root, 'db.sqlite')
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function installed() {
  const file = path()
  openDb({ path: file }).$client.close()
  return file
}
function failure(file: string): SchemaHistoryError {
  try {
    openDb({ path: file })
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaHistoryError)
    return error as SchemaHistoryError
  }
  throw new Error('expected schema drift')
}
describe('RFC-275 native epoch-2 schema admission', () => {
  test('fresh installation and unchanged reopen admit history and catalog', () => {
    openDb({ path: installed() }).$client.close()
  })
  test('a changed immutable history receipt is rejected without applying anything', () => {
    const file = installed()
    const raw = new Database(file)
    raw.exec("UPDATE aw_meta_schema_history SET contract_digest = 'changed'")
    const before = raw.query('SELECT * FROM aw_meta_schema_history').all()
    raw.close()
    expect(failure(file).code).toBe('receipt-mismatch')
    const after = new Database(file, { readonly: true })
    try {
      expect(after.query('SELECT * FROM aw_meta_schema_history').all()).toEqual(before)
    } finally {
      after.close()
    }
  })
  test('a self-consistent renamed column is physical drift even with intact receipts', () => {
    const file = installed()
    const raw = new Database(file)
    raw.exec(
      'ALTER TABLE mcp_runtime_test_turns RENAME COLUMN spawn_binary_path TO spawn_binary_path_missing',
    )
    raw.close()
    const error = failure(file)
    expect(error.code).toBe('physical-drift')
    expect(error.message).toContain('mcp_runtime_test_turns')
    const repair = new Database(file)
    repair.exec('BEGIN EXCLUSIVE; ROLLBACK')
    repair.close()
  })
  test('extra objects are rejected and a skipMigrations business connection still requires a generation', () => {
    const file = installed()
    const raw = new Database(file)
    raw.exec('CREATE TABLE unexpected_probe (value text)')
    raw.close()
    expect(failure(file).code).toBe('physical-drift')
    const customPath = path()
    const custom = new Database(customPath)
    custom.exec('CREATE TABLE custom_only (value text)')
    custom.close()
    expect(() => openDb({ path: customPath, skipMigrations: true })).toThrow()
  })
})
