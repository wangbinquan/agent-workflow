import { afterEach, describe, expect, test } from 'bun:test'
import { LEGACY_MIGRATION_HASHES } from '../src/db/schemaAdmission'
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

// RFC-317 T46（CC-03）—— 这张表原本在这里被**手抄了一份**（8 条哈希逐字重写）。
// 手抄的账本必然与生产走散，且走散时不会红：生产那边加一条别名，这里照旧只认自己
// 那 8 条，新别名从来没被任何断言看过。现在直接 import 生产常量。
//
// 生产表的值是 `readonly string[]`（一个 tag 可以有多条历史别名）；本文件的辅助函数
// 按「每个 tag 恰好一条」使用，所以在这里做一次显式收窄——若将来某个 tag 真的出现
// 第二条别名，下面那条断言会先红，而不是悄悄只取第一条。
/** 生产表按「tag → 唯一别名」摊平，供逐条断言使用。 */
function legacyAliasEntries(): Array<[string, string]> {
  return Object.keys(LEGACY_MIGRATION_HASHES).map((tag) => [tag, soleLegacyHash(tag)])
}

function soleLegacyHash(tag: string): string {
  const hashes = LEGACY_MIGRATION_HASHES[tag]
  if (hashes === undefined || hashes.length !== 1) {
    throw new Error(
      `legacy alias for ${tag} is not exactly one receipt (got ${hashes?.length ?? 0})`,
    )
  }
  return hashes[0]!
}

function expectedMigration(tag: string): ExpectedMigration {
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
  test('accepts only the observed full legacy migration hashes', () => {
    for (const [tag, legacyHash] of legacyAliasEntries()) {
      const expected = expectedMigration(tag)
      assertSingleReceipt(expected, expected.hash)
      assertSingleReceipt(expectedMigration(tag), legacyHash)
    }
  })

  test('rejects every mutated alias plus a wrong tag and timestamp', () => {
    const entries = legacyAliasEntries()
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
    for (const [tag, legacyHash] of legacyAliasEntries()) {
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
  }, 15_000)
})

// RFC-317 T46（CC-03）—— 别名账本的精确计数 + **可复核的存活判据**。
//
// 这张表原本在本文件里被手抄了一份，与生产的那份各改各的；现在共用一个对象，
// 下面两条则把「它有多大」和「每一条是不是还活着」变成断言。
//
// 存活判据刻意不用散文 `why`：绝大多数别名的理由是同一句话（"生产库里已应用的是
// 规范化之前的字节"），一模一样的 why 抄 N 份只会让人不再读它。真正能自己过期的判据是——
// **别名哈希必须与该 tag 当前规范文件的哈希不同**。相同就说明规范文件已经回到了当年
// 被应用的字节，这条别名是死的，应当删掉；死别名不是多余的一行，是一张空白许可证：
// 它让那个 tag 上未来任何一次字节漂移都能冒充"历史回执"通过准入。
describe('RFC-317 T46（CC-03）—— 历史迁移别名账本', () => {
  const LEDGER_SIZE = 9

  test('账本恰好 9 条（增删都要显式改这个数字）', () => {
    expect(
      Object.keys(LEGACY_MIGRATION_HASHES).length,
      '别名表变大了：每多一条，就多一个 tag 允许非规范字节通过准入。加之前先问' +
        '"这台库为什么还在跑那份旧字节"',
    ).toBe(LEDGER_SIZE)
  })

  test('每个 tag 恰好一条别名（出现第二条要显式面对，而不是被 [0] 悄悄吞掉）', () => {
    const multi = Object.entries(LEGACY_MIGRATION_HASHES)
      .filter(([, hashes]) => hashes.length !== 1)
      .map(([tag, hashes]) => `${tag}（${hashes.length} 条）`)
    expect(multi).toEqual([])
  })

  test('每条别名都仍与规范哈希不同（相同 ⇒ 这条已死，必须删）', () => {
    const dead: string[] = []
    for (const [tag, legacyHash] of legacyAliasEntries()) {
      const canonical = expectedMigration(tag)
      if (canonical.hash === legacyHash) dead.push(`${tag}（别名 == 规范哈希）`)
    }
    expect(
      dead,
      '死别名是一张空白许可证：它让该 tag 上未来任何一次字节漂移都能冒充历史回执通过准入',
    ).toEqual([])
  })

  test('每个 tag 都在当前迁移链上存在（迁移被删/改名 ⇒ 别名先红）', () => {
    const missing: string[] = []
    for (const [tag] of legacyAliasEntries()) {
      try {
        expectedMigration(tag)
      } catch {
        missing.push(tag)
      }
    }
    expect(missing, '别名指向了一个不存在的迁移——链变了，账本没跟上').toEqual([])
  })
})
