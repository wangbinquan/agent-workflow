// RFC-210 T10/T11 — migration 0102 建的三列。
//
// 为什么这条测试存在：仓里每条加列的 migration 都配一条同形测试（见
// migration-0098-rfc204-repo-cred / migration-0090-rfc170 等），锁住列真的建出来了、
// 类型对、且可空——可空是关键，存量行没有这些值，非空约束会让升级直接失败。
//
// iso_submodules_json 与 iso_submodules_repos_json 必须成对存在：多仓任务的
// submodule 拓扑是 per-repo 的，塞进一个扁平 map 会让两个都含 `vendor` 的仓
// 互相覆盖。这与既有的 iso_base_snapshot / iso_base_snapshot_repos_json 同制。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function columns(db: Database, table: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]
}

const MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'db', 'migrations')

function withMigratedDb<T>(fn: (raw: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig-0102-'))
  const dbPath = join(dir, 'test.db')
  try {
    openDb({ path: dbPath, migrationsFolder: MIGRATIONS_FOLDER })
    // Reopen raw for PRAGMA introspection; drizzle's handle wraps the same file.
    const raw = new Database(dbPath, { readwrite: true })
    try {
      return fn(raw)
    } finally {
      raw.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('migration 0102 — RFC-210 submodule isolation columns', () => {
  test('cached_repos.last_auto_refresh_at exists, INTEGER, nullable', () => {
    withMigratedDb((db) => {
      const col = columns(db, 'cached_repos').find((c) => c.name === 'last_auto_refresh_at')
      expect(col).toBeDefined()
      expect(col?.type).toBe('INTEGER')
      expect(col?.notnull).toBe(0)
    })
  })

  test('node_runs gets BOTH iso_submodules columns, TEXT, nullable', () => {
    withMigratedDb((db) => {
      const cols = columns(db, 'node_runs')
      for (const name of ['iso_submodules_json', 'iso_submodules_repos_json']) {
        const col = cols.find((c) => c.name === name)
        expect(col).toBeDefined()
        expect(col?.type).toBe('TEXT')
        expect(col?.notnull).toBe(0)
      }
    })
  })

  test('the single/multi pair mirrors the existing iso_base_snapshot pair', () => {
    withMigratedDb((db) => {
      const names = new Set(columns(db, 'node_runs').map((c) => c.name))
      // If someone ever drops one half of either pair, multi-repo tasks lose
      // per-repo isolation state silently.
      expect(names.has('iso_base_snapshot')).toBe(true)
      expect(names.has('iso_base_snapshot_repos_json')).toBe(true)
      expect(names.has('iso_submodules_json')).toBe(true)
      expect(names.has('iso_submodules_repos_json')).toBe(true)
    })
  })

  test('existing rows tolerate the new columns (insert without them)', () => {
    withMigratedDb((db) => {
      // A legacy-shaped insert must still work — the columns are additive.
      db.run(
        `INSERT INTO cached_repos (id, url_hash, url, local_path, last_fetched_at, created_at)
         VALUES ('r1', 'h1', '', '/tmp/r1', 0, 0)`,
      )
      const row = db.query(`SELECT last_auto_refresh_at FROM cached_repos WHERE id='r1'`).get() as {
        last_auto_refresh_at: number | null
      }
      expect(row.last_auto_refresh_at).toBeNull()
    })
  })
})
