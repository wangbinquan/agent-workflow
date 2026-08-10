import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { openDb } from '../src/db/client'
import { DbSchemaDriftError } from '../src/db/schemaAdmission'

const SOURCE_MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc275-'))
  roots.push(root)
  return root
}

function copiedMigrations(root: string): string {
  const target = join(root, 'migrations')
  cpSync(SOURCE_MIGRATIONS, target, { recursive: true })
  return target
}

function captureDrift(run: () => unknown): DbSchemaDriftError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DbSchemaDriftError)
    return error as DbSchemaDriftError
  }
  throw new Error('expected schema drift')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-275 database schema admission', () => {
  test('a fresh DB and an unchanged reopen pass both history and physical admission', () => {
    const root = tempRoot()
    const dbPath = join(root, 'db.sqlite')
    const migrationsFolder = copiedMigrations(root)
    const first = openDb({ path: dbPath, migrationsFolder })
    first.$client.close()
    const second = openDb({ path: dbPath, migrationsFolder })
    second.$client.close()
  })

  test('an applied migration file edited later is rejected in preflight before migration writes', () => {
    const root = tempRoot()
    const dbPath = join(root, 'db.sqlite')
    const migrationsFolder = copiedMigrations(root)
    const db = openDb({ path: dbPath, migrationsFolder })
    const before = db.$client.query('SELECT count(*) AS count FROM __drizzle_migrations').get() as {
      count: number
    }
    db.$client.close()

    appendFileSync(
      join(migrationsFolder, '0125_rfc238_mcp_runtime_playground.sql'),
      '\n-- edited after this receipt was recorded\n',
    )
    const error = captureDrift(() => openDb({ path: dbPath, migrationsFolder }))
    expect(error.stage).toBe('migration-history-preflight')
    expect(error.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'migration-hash',
          tag: '0125_rfc238_mcp_runtime_playground',
        }),
      ]),
    )

    const raw = new Database(dbPath)
    const after = raw.query('SELECT count(*) AS count FROM __drizzle_migrations').get() as {
      count: number
    }
    expect(after.count).toBe(before.count)
    raw.close()
  })

  test('the reported RFC-238 shape is rejected even when every receipt is intact', () => {
    const root = tempRoot()
    const dbPath = join(root, 'db.sqlite')
    const migrationsFolder = copiedMigrations(root)
    const db = openDb({ path: dbPath, migrationsFolder })
    db.$client.close()

    // SQLite rewrites dependent CHECK text on rename, leaving a self-consistent
    // but non-canonical table while __drizzle_migrations remains untouched.
    const raw = new Database(dbPath)
    raw.exec(
      'ALTER TABLE mcp_runtime_test_turns RENAME COLUMN spawn_binary_path TO spawn_binary_path_missing;',
    )
    raw.close()

    const error = captureDrift(() => openDb({ path: dbPath, migrationsFolder }))
    expect(error.stage).toBe('physical-schema')
    expect(error.differences).toEqual(
      expect.arrayContaining([
        {
          kind: 'column-missing',
          table: 'mcp_runtime_test_turns',
          column: 'spawn_binary_path',
        },
      ]),
    )
    // openDb closed the rejected connection; repair tooling can lock it now.
    const repair = new Database(dbPath)
    repair.exec('BEGIN EXCLUSIVE; ROLLBACK;')
    repair.close()
  })

  test('extra schema objects are named; skipMigrations keeps custom-schema test seams untouched', () => {
    const root = tempRoot()
    const dbPath = join(root, 'db.sqlite')
    const migrationsFolder = copiedMigrations(root)
    const db = openDb({ path: dbPath, migrationsFolder })
    db.$client.exec('CREATE TABLE unexpected_probe (value text);')
    db.$client.close()

    const error = captureDrift(() => openDb({ path: dbPath, migrationsFolder }))
    expect(error.stage).toBe('physical-schema')
    expect(error.differences).toEqual(
      expect.arrayContaining([
        { kind: 'object-extra', objectType: 'table', name: 'unexpected_probe' },
      ]),
    )

    const customPath = join(root, 'custom.sqlite')
    const custom = new Database(customPath)
    custom.exec('CREATE TABLE custom_only (value text);')
    custom.close()
    const skipped = openDb({
      path: customPath,
      migrationsFolder: join(root, basename(migrationsFolder)),
      skipMigrations: true,
    })
    skipped.$client.close()
  })
})
