// Locks the createInMemoryDb() snapshot optimization in src/db/client.ts.
//
// createInMemoryDb now hydrates each test DB from a once-migrated, serialized
// SQLite image (migratedSnapshot) instead of replaying every migration on each
// call (~18ms → ~0.1ms; the backend suite calls it ~260×). These assertions
// guard the only two ways that optimization could silently break:
//
//   1. SCHEMA DRIFT — a hydrated DB must be byte-for-byte schema-identical to a
//      DB produced by replaying every migration the OLD way (same tables /
//      indexes / triggers, same CREATE SQL, same applied-migration count). If
//      serialize/deserialize ever dropped an object, callers would unknowingly
//      test against an incomplete schema.
//   2. CROSS-TEST BLEED — two createInMemoryDb() instances must be fully
//      independent; DDL/DML in one must be invisible in another. If Bun's
//      Database.deserialize ever aliased the shared snapshot buffer, tests would
//      contaminate each other order-dependently. (Verified isolated at the time
//      of writing; this locks it.)
//
// Added alongside the snapshot change; see db/client.ts migratedSnapshot().

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { sql } from 'drizzle-orm'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/** Control DB: built the OLD way — raw :memory: + replay every migration.
 *
 * RFC-285 T5 改锚：重放期 FK **OFF**、结束后 ON——对齐本仓受支持的迁移重放
 * 契约（RFC-115 F1：drizzle 单事务内 pragma 无效，openDb / migratedSnapshot
 * 均事务外先 OFF 再迁移）。原来 FK ON 重放只在「链上没有父表重建」时侥幸
 * 等价；0151（tasks 12-step rebuild）落地后，FK ON 下 RENAME 会把 14 个子表
 * 的引用文本改写成 `__old_tasks`——那不是快照优化的缺陷，而是不受支持的
 * 重放模式本身的产物。本测试的意图是「hydration ≡ 受支持方式的 replay」。 */
function freshlyMigratedControl(): Database {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF;')
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })
  sqlite.exec('PRAGMA foreign_keys = ON;')
  return sqlite
}

/** name+sql for every object in sqlite_master, ordered — the full schema fingerprint. */
function schemaFingerprint(rows: unknown[][]): string {
  return rows
    .map((r) => `${String(r[0])}\t${String(r[1] ?? '')}`)
    .sort()
    .join('\n')
}

const MASTER_QUERY =
  "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"

describe('createInMemoryDb snapshot parity', () => {
  test('hydrated schema is identical to a freshly-replayed migration chain', () => {
    const control = freshlyMigratedControl()
    const controlRows = control.query(MASTER_QUERY).values() as unknown[][]

    const hydrated = createInMemoryDb(MIGRATIONS)
    const hydratedRows = hydrated.values(sql.raw(MASTER_QUERY)) as unknown[][]

    // Non-trivial schema actually present (guards against an empty snapshot).
    const tableNames = controlRows.map((r) => String(r[0])).filter((n) => !n.startsWith('__'))
    expect(tableNames.length).toBeGreaterThanOrEqual(30)

    // The fingerprint (tables + indexes + triggers + their CREATE SQL) must match.
    expect(schemaFingerprint(hydratedRows)).toBe(schemaFingerprint(controlRows))
  })

  test('all migrations are applied (count matches the migrations folder)', () => {
    const sqlFileCount = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).length
    expect(sqlFileCount).toBeGreaterThan(0)

    const db = createInMemoryDb(MIGRATIONS)
    const appliedRows = db.values(
      sql.raw('SELECT count(*) FROM __drizzle_migrations'),
    ) as unknown[][]
    expect(Number(appliedRows[0]?.[0])).toBe(sqlFileCount)
  })

  test('foreign-key enforcement is ON (per-connection pragma re-applied after deserialize)', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const fkRows = db.values(sql.raw('PRAGMA foreign_keys')) as unknown[][]
    expect(Number(fkRows[0]?.[0])).toBe(1)
  })

  test('two instances are fully isolated — DDL in one is invisible in the other', () => {
    const a = createInMemoryDb(MIGRATIONS)
    const b = createInMemoryDb(MIGRATIONS)

    a.run(sql.raw('CREATE TABLE __isolation_probe (x integer)'))

    const seenInB = b.values(
      sql.raw("SELECT name FROM sqlite_master WHERE name = '__isolation_probe'"),
    ) as unknown[][]
    expect(seenInB.length).toBe(0)

    // And a still has its probe (sanity that the write landed somewhere).
    const seenInA = a.values(
      sql.raw("SELECT name FROM sqlite_master WHERE name = '__isolation_probe'"),
    ) as unknown[][]
    expect(seenInA.length).toBe(1)
  })
})
