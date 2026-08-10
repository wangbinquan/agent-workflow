import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../src/db/client'
import {
  assertMigrationHistory,
  DbSchemaDriftError,
  readExpectedMigrationChain,
  type ExpectedMigration,
} from '../src/db/schemaAdmission'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempRoots: string[] = []

const LEGACY_MIGRATION_HASHES = {
  '0052_rfc108_recovery_events': '3b5f02214e1c06a1b05ab2eaef4d1209815d60198850eba9ad4a899fa14c96f0',
  '0069_rfc129_review_selection_stale':
    '547c53f30c3a8a8fd4df278ce0310e4a2a89f3683b6336559c31093b669f4e24',
  '0084_rfc164_workgroup_tasks': '8c9f8244e564b54951c284a5ed7f20f0c9077d621ff7d49465420490182024b7',
  '0085_rfc165_task_space': '033da7e58069bce3c90c3f2688f018417fceb5bc0995577ce828a351590800a3',
  '0095_rfc189_wg_round': 'ae58ca1a757cc36c41af5b1a8a077a3bda436924ae074acf5a408babb5ccdfca',
  '0107_rfc217_clarify_unify_t17':
    '7d9cc403ede0aea34d7a6557ff0f10de73a8adb04fad09430e973c94aee2b1b4',
  '0125_rfc238_mcp_runtime_playground':
    '475944d58ef1c8341ed86e3c88ce080aebcef8dbc23548ea43345be3a8eee450',
  '0139_rfc261_webhook_delivery_scale':
    '1c14427b8a7f740617841f759c302f9efbe0ab611e3dd23b553c4a6a1ded794e',
} as const

function expectedMigration(tag: keyof typeof LEGACY_MIGRATION_HASHES): ExpectedMigration {
  const migration = readExpectedMigrationChain(MIGRATIONS).find((entry) => entry.tag === tag)
  if (migration === undefined) throw new Error(`missing canonical migration ${tag}`)
  return migration
}

function assertSingleReceipt(
  expected: ExpectedMigration,
  hash: string,
  when = expected.folderMillis,
) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE __drizzle_migrations (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    );
  `)
  raw.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, when)
  try {
    assertMigrationHistory(raw, {
      dbPath: ':memory:',
      expected: [expected],
      stage: 'migration-history-postflight',
      allowPrefix: false,
    })
  } finally {
    raw.close()
  }
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

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc278-'))
  tempRoots.push(root)
  return root
}

function copyMigrations(target: string, maxIdx?: number): string {
  cpSync(MIGRATIONS, target, { recursive: true })
  if (maxIdx !== undefined) {
    const journalPath = join(target, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx)
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  }
  return target
}

function tableExists(raw: Database, table: string): boolean {
  return (
    raw.query("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(table) !==
    null
  )
}

function indexExists(raw: Database, index: string): boolean {
  return (
    raw.query("SELECT 1 AS present FROM sqlite_schema WHERE type='index' AND name=?").get(index) !==
    null
  )
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-278 legacy schema reconciliation', () => {
  test('accepts only the eight observed full legacy migration hashes', () => {
    for (const [tag, legacyHash] of Object.entries(LEGACY_MIGRATION_HASHES) as Array<
      [keyof typeof LEGACY_MIGRATION_HASHES, string]
    >) {
      const expected = expectedMigration(tag)
      assertSingleReceipt(expected, expected.hash)
      assertSingleReceipt(expectedMigration(tag), legacyHash)
    }
  })

  test('rejects every mutated alias plus a wrong tag and timestamp', () => {
    const entries = Object.entries(LEGACY_MIGRATION_HASHES) as Array<
      [keyof typeof LEGACY_MIGRATION_HASHES, string]
    >
    for (const [tag, legacyHash] of entries) {
      const mutatedHash = `${legacyHash.slice(0, -1)}${legacyHash.endsWith('0') ? '1' : '0'}`
      expect(
        captureDrift(() => assertSingleReceipt(expectedMigration(tag), mutatedHash)).stage,
      ).toBe('migration-history-postflight')
    }

    const [tag, legacyHash] = entries[0]!
    const expected = expectedMigration(tag)
    expect(
      captureDrift(() => assertSingleReceipt({ ...expected, tag: entries[1]![0] }, legacyHash))
        .differences,
    ).toEqual([expect.objectContaining({ kind: 'migration-hash' })])
    expect(
      captureDrift(() => assertSingleReceipt(expected, legacyHash, expected.folderMillis + 1))
        .differences,
    ).toEqual([expect.objectContaining({ kind: 'migration-order' })])
  })

  test('upgrades the observed 0141 shape, preserves recovery rows, and removes retired state', () => {
    const root = tempRoot()
    const dbPath = join(root, 'legacy.sqlite')
    const frozenMigrations = copyMigrations(join(root, 'migrations-0141'), 140)
    const currentMigrations = copyMigrations(join(root, 'migrations-head'))
    const raw = new Database(dbPath, { create: true })
    raw.exec('PRAGMA foreign_keys = OFF;')
    migrate(drizzle(raw), { migrationsFolder: frozenMigrations })

    raw.exec(`
      DROP INDEX idx_recovery_events_task;
      DROP INDEX idx_recovery_events_kind;
      DROP TABLE recovery_events;
      CREATE TABLE recovery_events (
        id text PRIMARY KEY NOT NULL,
        task_id text,
        node_run_id text,
        actor text NOT NULL, -- 'system' or a user id
        kind text NOT NULL,  -- legacy inline event catalog
        reason text,
        before_json text,
        after_json text,
        created_at integer NOT NULL
      );
      INSERT INTO recovery_events (
        id, task_id, node_run_id, actor, kind, reason,
        before_json, after_json, created_at
      ) VALUES (
        'recovery-rfc278', 'task-preserved', 'run-preserved', 'startup',
        'task-interrupted', 'sentinel-reason', '{"before":1}', '{"after":2}', 42
      );

      INSERT INTO users (
        id, username, display_name, role, status, force_password_change,
        created_at, updated_at
      ) VALUES ('user-rfc278', 'user-rfc278', 'RFC 278', 'user', 'active', 0, 1, 1);
      INSERT INTO mcps (
        id, name, description, type, config, enabled, owner_user_id,
        visibility, acl_revision, schema_version, created_at, updated_at
      ) VALUES (
        'mcp-rfc278', 'mcp-rfc278', '', 'local', '{"command":["fixture"]}', 1,
        'user-rfc278', 'private', 0, 1, 1, 1
      );

      DROP TABLE mcp_runtime_test_create_receipts;
      CREATE TABLE mcp_runtime_test_create_receipts (
        mcp_id text NOT NULL,
        owner_user_id text NOT NULL,
        client_create_id text NOT NULL,
        request_digest text NOT NULL,
        session_id text NOT NULL,
        accepted_turn_id text NOT NULL,
        created_at integer NOT NULL,
        expires_at integer NOT NULL,
        PRIMARY KEY (mcp_id, owner_user_id, client_create_id)
      );
      CREATE INDEX idx_mcp_runtime_test_create_receipts_expiry
        ON mcp_runtime_test_create_receipts (expires_at);
      INSERT INTO mcp_runtime_test_create_receipts (
        mcp_id, owner_user_id, client_create_id, request_digest,
        session_id, accepted_turn_id, created_at, expires_at
      ) VALUES (
        'mcp-rfc278', 'user-rfc278', 'old-create', '${'a'.repeat(64)}',
        'old-native-session', 'old-turn', 1, 86400001
      );

      CREATE TABLE recent_repos (
        path text PRIMARY KEY NOT NULL,
        last_used_at integer NOT NULL,
        default_branch text
      );
      INSERT INTO recent_repos (path, last_used_at, default_branch) VALUES
        ('/legacy/a', 1, 'main'),
        ('/legacy/b', 2, 'main'),
        ('/legacy/c', 3, NULL);
    `)

    const recoveryBefore = raw
      .query("SELECT * FROM recovery_events WHERE id='recovery-rfc278'")
      .get()
    for (const [tag, legacyHash] of Object.entries(LEGACY_MIGRATION_HASHES) as Array<
      [keyof typeof LEGACY_MIGRATION_HASHES, string]
    >) {
      raw
        .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
        .run(legacyHash, expectedMigration(tag).folderMillis)
    }
    raw.close()

    const upgraded = openDb({ path: dbPath, migrationsFolder: currentMigrations })
    const sqlite = upgraded.$client
    expect(sqlite.query("SELECT * FROM recovery_events WHERE id='recovery-rfc278'").get()).toEqual(
      recoveryBefore,
    )
    expect(indexExists(sqlite, 'idx_recovery_events_task')).toBe(true)
    expect(indexExists(sqlite, 'idx_recovery_events_kind')).toBe(true)
    expect(
      sqlite.query('SELECT count(*) AS count FROM mcp_runtime_test_create_receipts').get(),
    ).toEqual({ count: 0 })
    expect(
      (
        sqlite.query("PRAGMA foreign_key_list('mcp_runtime_test_create_receipts')").all() as Array<{
          table: string
        }>
      )
        .map((row) => row.table)
        .sort(),
    ).toEqual(['mcps', 'users'])
    expect(indexExists(sqlite, 'idx_mcp_runtime_test_create_receipts_expiry')).toBe(true)
    expect(tableExists(sqlite, 'recent_repos')).toBe(false)
    expect(tableExists(sqlite, 'rfc276_legacy_runtime_archive')).toBe(false)
    expect(sqlite.query('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: readExpectedMigrationChain(currentMigrations).length,
    })

    expect(() =>
      sqlite
        .query(
          `INSERT INTO mcp_runtime_test_create_receipts (
             mcp_id, owner_user_id, client_create_id, request_digest,
             session_id, accepted_turn_id, created_at, expires_at
           ) VALUES ('mcp-rfc278', 'user-rfc278', 'invalid-digest', ?, 'session', 'turn', 1, 2)`,
        )
        .run(`${'a'.repeat(63)}z`),
    ).toThrow()
    expect(() =>
      sqlite
        .query(
          `INSERT INTO mcp_runtime_test_create_receipts (
             mcp_id, owner_user_id, client_create_id, request_digest,
             session_id, accepted_turn_id, created_at, expires_at
           ) VALUES ('missing-mcp', 'user-rfc278', 'missing-parent', ?, 'session', 'turn', 1, 2)`,
        )
        .run('b'.repeat(64)),
    ).toThrow()
    upgraded.$client.close()

    const reopened = openDb({ path: dbPath, migrationsFolder: currentMigrations })
    expect(reopened.$client.query('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
    expect(reopened.$client.query('PRAGMA foreign_key_check').all()).toEqual([])
    reopened.$client.close()
  })
})
