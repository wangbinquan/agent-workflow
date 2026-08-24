// SQLite + Drizzle client + auto-migration on startup.
// Used by the daemon's main entry; tests use createInMemoryDb().

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema'
import {
  assertMigrationHistory,
  assertPhysicalSchema,
  readExpectedMigrationChain,
} from './schemaAdmission'

export type DbClient = ReturnType<typeof drizzle<typeof schema>>

/**
 * RFC-213 — the primary DB failed its integrity gate on open. The daemon fails
 * CLOSED on this (start.ts prints the available backups + a restore command and
 * exits non-zero) rather than serving corrupt data.
 */
export class DbCorruptionError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly checkErrors: string[],
  ) {
    super(
      `database corruption detected at ${dbPath}: ${checkErrors.slice(0, 5).join('; ')}` +
        (checkErrors.length > 5 ? ` (+${checkErrors.length - 5} more)` : ''),
    )
    this.name = 'DbCorruptionError'
  }
}

export interface OpenDbOptions {
  /** Absolute path to the sqlite file. */
  path: string
  /** Path to the migrations folder. */
  migrationsFolder: string
  /** Skip running migrations on open (mainly for tests that inject schema directly). */
  skipMigrations?: boolean
  /** RFC-213: skip the PRAGMA quick_check integrity gate (escape hatch). */
  skipIntegrityCheck?: boolean
  /** RFC-213: PRAGMA synchronous mode (default NORMAL — byte-equivalent to prior). */
  synchronous?: 'NORMAL' | 'FULL'
  /** RFC-311: PRAGMA cache_size budget in MiB (default 128). The daemon runs a
   *  single connection over a multi-GB file; SQLite's ~2MB default page cache
   *  turns every wide scan into cold disk reads. */
  pageCacheMib?: number
  /** RFC-311: PRAGMA mmap_size window in MiB (default 512, 0 disables). The
   *  engine silently falls back to 0 on filesystems without mmap support. */
  mmapMib?: number
  /** RFC-311: warn-log any statement slower than this many ms (default 50,
   *  0 disables). Every statement here runs synchronously on the daemon's
   *  event loop, so a slow one freezes ALL HTTP/WS — surface them. */
  slowQueryMs?: number
}

/** 进程累计 CPU 时间（微秒）。不可用时返回 null——诊断字段绝不能成为新的崩溃源。 */
function cpuMicros(): number | null {
  try {
    const u = process.cpuUsage()
    return u.user + u.system
  } catch {
    return null
  }
}

/**
 * RFC-311 — slow-statement telemetry for the daemon's synchronous connection.
 *
 * bun:sqlite has no query hook, so wrap the two entry points drizzle actually
 * uses (`prepare` → Statement.all/get/run/values, and `exec`) plus `query`
 * (bun's cached variant used by our own maintenance code). Timing covers the
 * synchronous execution only; iterator consumption (`iterate`) is not timed.
 * Exported for direct unit testing with an injected log sink.
 *
 * RFC-322 —— 墙钟之外再记一个 **CPU 时间**，因为墙钟单独一个量是会骗人的：daemon 只有
 * 一条同步连接，进程被饿死 / 阻塞在 IO 时，整段停顿会被算到当时正在执行的那条语句头上。
 * 生产实测的 `[db-slow] 32648ms` 就是这样来的——那条 SELECT 同库实测 10ms、走索引、表
 * 仅 346 行。判据：
 *   · `cpuMs ≈ ms` ⇒ 这条语句真的在算，是查询问题（查计划 / 索引 / 数据量）；
 *   · `cpuMs ≪ ms` ⇒ 进程在等，**与这条 SQL 无关**（去查谁占住了事件循环，
 *     典型是同刻引爆的维护任务——见 `services/daemonCadence.ts` 的 MAINTENANCE_PHASE）。
 */
export function instrumentSlowStatements(
  sqlite: Database,
  thresholdMs: number,
  // RFC-322：`cpuMs` 是**尾参**，既有 2 参回调（tests/rfc311-perf-foundation.test.ts
  // 有 4 处）逐字不受影响。
  logSlow: (ms: number, sql: string, cpuMs: number) => void = (ms, sql, cpuMs) =>
    console.warn(`[db-slow] ${ms}ms (cpu ${cpuMs < 0 ? 'n/a' : `${cpuMs}ms`}): ${sql}`),
): void {
  if (thresholdMs <= 0) return
  const clip = (sql: string): string => (sql.length > 300 ? `${sql.slice(0, 300)}…` : sql)
  const timed = <A extends unknown[], R>(sql: string, fn: (...args: A) => R) => {
    return (...args: A): R => {
      const t0 = performance.now()
      // 实测 0.40µs/次（`performance.now()` 是 11ns）。第二次只在超阈时才付，
      // 所以快路径的固定成本是一次调用；相对最便宜的索引查询（~10µs）可以接受。
      const c0 = cpuMicros()
      try {
        return fn(...args)
      } finally {
        const ms = performance.now() - t0
        if (ms >= thresholdMs) {
          const c1 = c0 === null ? null : cpuMicros()
          const cpuMs = c0 === null || c1 === null ? -1 : Math.round((c1 - c0) / 1000)
          logSlow(Math.round(ms), clip(sql), cpuMs)
        }
      }
    }
  }
  const wrapStatement = (stmt: object, sql: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        // 取值时**不能**把 receiver 传下去:bun:sqlite 的 Statement 是 native
        // class,它的取值器(columnNames / paramsCount / native)要读私有字段,
        // receiver 是 Proxy 时直接抛 "Cannot access invalid private field"。
        // 当前 drizzle 只调方法所以没炸,但任何人读一次 columnNames 就会在
        // **开了慢查询计时的生产**上炸、关掉时不炸(实现门 P3-13)。
        const value = Reflect.get(target, prop) as unknown
        if (typeof value !== 'function') return value
        const bound = (value as (...a: unknown[]) => unknown).bind(target)
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'values') {
          return timed(sql, bound)
        }
        return bound
      },
    })
  for (const method of ['prepare', 'query'] as const) {
    const orig = (sqlite[method] as (...a: unknown[]) => object).bind(sqlite)
    ;(sqlite as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      wrapStatement(orig(...args), String(args[0]))
  }
  const origExec = (sqlite.exec as (...a: unknown[]) => unknown).bind(sqlite)
  ;(sqlite as unknown as Record<string, unknown>).exec = (...args: unknown[]) =>
    timed(String(args[0]), origExec)(...args)
}

/**
 * Open the daemon's primary database. Creates the parent directory if missing,
 * applies WAL + busy_timeout per design.md §11, runs a fail-closed integrity
 * gate (RFC-213), and applies all pending Drizzle migrations.
 */
export function openDb(opts: OpenDbOptions): DbClient {
  mkdirSync(dirname(opts.path), { recursive: true })

  // A truncated / header-clobbered file throws at OPEN or the first PRAGMA —
  // BEFORE quick_check can run — so fold that into the same corruption signal.
  let sqlite: Database
  try {
    sqlite = new Database(opts.path, { create: true })
    // Best-effort 0600, matching secret.key: the DB holds credentials and
    // umask-default permissions could expose them to other local accounts.
    try {
      chmodSync(opts.path, 0o600)
    } catch {
      /* read-only fs / exotic mounts — never block open */
    }
    // Per design.md §11.0: WAL + synchronous + 5s busy timeout. journal_mode=WAL
    // is where a malformed header typically throws.
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqlite.exec(`PRAGMA synchronous = ${opts.synchronous === 'FULL' ? 'FULL' : 'NORMAL'};`)
    sqlite.exec('PRAGMA busy_timeout = 5000;')
    // RFC-311 — capacity pragmas for a single long-lived connection over a
    // multi-GB file. Negative cache_size = KiB budget. mmap_size is a request:
    // unsupported filesystems answer 0 and reads fall back to the page cache.
    // temp_store=MEMORY keeps recursive-CTE/sort scratch out of disk temp files.
    const pageCacheMib = Math.max(2, Math.floor(opts.pageCacheMib ?? 128))
    sqlite.exec(`PRAGMA cache_size = ${-pageCacheMib * 1024};`)
    const mmapMib = Math.max(0, Math.floor(opts.mmapMib ?? 512))
    sqlite.exec(`PRAGMA mmap_size = ${mmapMib * 1024 * 1024};`)
    sqlite.exec('PRAGMA temp_store = MEMORY;')
  } catch (err) {
    throw new DbCorruptionError(opts.path, [err instanceof Error ? err.message : String(err)])
  }

  // RFC-213 fail-closed integrity gate, BEFORE migrations. Catches a header-intact
  // but page-corrupt DB that opened fine above. quick_check is ~an order of
  // magnitude faster than integrity_check and enough for structural corruption.
  if (opts.skipIntegrityCheck !== true) {
    let rows: { quick_check: string }[]
    try {
      rows = sqlite.query('PRAGMA quick_check;').all() as { quick_check: string }[]
    } catch (err) {
      sqlite.close()
      throw new DbCorruptionError(opts.path, [err instanceof Error ? err.message : String(err)])
    }
    const ok = rows.length === 1 && rows[0]?.quick_check === 'ok'
    if (!ok) {
      sqlite.close()
      throw new DbCorruptionError(
        opts.path,
        rows.map((r) => r.quick_check),
      )
    }
  }

  const db = drizzle(sqlite, { schema })
  try {
    if (!opts.skipMigrations) {
      const migrationsFolder = resolve(opts.migrationsFolder)
      const expected = readExpectedMigrationChain(migrationsFolder)
      // RFC-275: Drizzle otherwise trusts only the latest timestamp. Verify the
      // entire applied prefix before any migration is allowed to write.
      assertMigrationHistory(sqlite, {
        dbPath: opts.path,
        expected,
        stage: 'migration-history-preflight',
        allowPrefix: true,
      })

      // RFC-115 (Codex audit F1): run migrations with foreign_keys OFF. drizzle
      // wraps ALL migrations in ONE transaction, and `PRAGMA foreign_keys` is a
      // no-op INSIDE a transaction — so a 12-step rebuild's own
      // `PRAGMA foreign_keys=OFF` never takes effect and its `DROP TABLE <x>`
      // cascade-deletes child rows on upgrade (0058 DROP doc_versions →
      // review_comments wiped via ON DELETE cascade; 0035/0041 are the same shape
      // for node_runs). Toggle OUTSIDE drizzle's tx, then re-enable + verify.
      sqlite.exec('PRAGMA foreign_keys = OFF;')
      migrate(db, { migrationsFolder })
      // F1-followup (Codex gate): WARN, don't throw. foreign_key_check runs AFTER
      // drizzle's migration tx has COMMITTED, so throwing can't roll back — it would
      // only brick startup on a pre-existing orphan (a half-upgraded DB that fails
      // every boot). Normal INSERT..SELECT rebuilds introduce no violations; a real
      // one is a migration bug for migration tests to catch, not a reason to fail
      // every boot. Surface it (scoped to the offending rows) and continue.
      const violations = sqlite.query('PRAGMA foreign_key_check;').all()
      if (violations.length > 0) {
        console.warn(
          `[db] post-migration foreign_key_check found ${violations.length} violation(s); ` +
            `continuing (a committed migration cannot be rolled back here): ${JSON.stringify(violations)}`,
        )
      }
      assertMigrationHistory(sqlite, {
        dbPath: opts.path,
        expected,
        stage: 'migration-history-postflight',
        allowPrefix: false,
      })
      sqlite.exec('PRAGMA foreign_keys = ON;')
      assertPhysicalSchema(sqlite, {
        dbPath: opts.path,
        migrationsFolder,
        expectedMigrations: expected,
      })
    } else {
      sqlite.exec('PRAGMA foreign_keys = ON;')
    }
    // RFC-311 — armed after migrations so one-time upgrade work stays out of
    // the steady-state slow log.
    instrumentSlowStatements(sqlite, opts.slowQueryMs ?? 50)
    return db
  } catch (err) {
    // Admission/migration failures happen before the caller owns the client.
    // Close here so repair tools can immediately obtain an exclusive handle.
    sqlite.close()
    throw err
  }
}

/**
 * Per-process cache of a fully-migrated in-memory SQLite image, keyed by the
 * resolved migrations folder. The migrations are replayed exactly ONCE per
 * folder per process; every subsequent createInMemoryDb() call hydrates a
 * fresh, independent database from the serialized image instead of re-running
 * all migrations (~18ms → ~0.1ms per call; the backend suite calls this ~260×).
 *
 * Safe because the migrated schema is deterministic and Bun's
 * Database.deserialize() copies the image — each test gets a private DB, so
 * writes never bleed across tests (locked by createindb-snapshot-parity.test.ts).
 */
const migratedSnapshotCache = new Map<string, Uint8Array>()
const legacyDaemonTestDbs = new WeakSet<object>()

/**
 * Compatibility seam for the pre-RFC-221 test suite, whose authenticated
 * route harnesses use the daemon token as a compact admin fixture. Production
 * `openDb()` clients are never registered here; bootstrap-focused tests opt
 * into `{ bootstrap: 'required' }` and exercise the real retirement rules.
 */
export function allowsLegacyDaemonTestAccess(db: DbClient): boolean {
  return legacyDaemonTestDbs.has(db as object)
}

function migratedSnapshot(migrationsFolder: string): Uint8Array {
  const key = resolve(migrationsFolder)
  let snapshot = migratedSnapshotCache.get(key)
  if (!snapshot) {
    const template = new Database(':memory:')
    // RFC-115 (Codex audit F1): migrate with FK OFF (see openDb) so 12-step
    // rebuilds don't cascade-delete child rows; the serialized image is FK-ON.
    template.exec('PRAGMA foreign_keys = OFF;')
    migrate(drizzle(template, { schema }), { migrationsFolder: key })
    template.exec('PRAGMA foreign_keys = ON;')
    snapshot = template.serialize()
    template.close()
    migratedSnapshotCache.set(key, snapshot)
  }
  return snapshot
}

/**
 * Open an in-memory database with all migrations applied.
 * Used by bun:test integration tests; no fs side-effects.
 *
 * The returned DB is a hydrated copy of a once-migrated template (see
 * migratedSnapshot). PRAGMA foreign_keys is a per-connection setting that is
 * NOT part of the serialized image, so it is re-applied here to preserve the
 * original (always-FK-on) contract.
 */
export interface CreateInMemoryDbOptions {
  /**
   * RFC-221: historical tests model an already-administered installation and
   * therefore keep daemon-token fixture access. Bootstrap-specific tests opt
   * into the real fresh-install state explicitly.
   */
  bootstrap?: 'ready' | 'required'
}

export function createInMemoryDb(
  migrationsFolder: string,
  opts: CreateInMemoryDbOptions = {},
): DbClient {
  const sqlite = Database.deserialize(migratedSnapshot(migrationsFolder))
  sqlite.exec('PRAGMA foreign_keys = ON;')
  if (opts.bootstrap !== 'required') {
    const hasPolicy = sqlite
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_login_policy'")
      .get()
    if (hasPolicy !== null) {
      sqlite.exec(
        "UPDATE auth_login_policy SET bootstrap_completed_at = COALESCE(bootstrap_completed_at, 0) WHERE id = 'global';",
      )
    }
  }
  const db = drizzle(sqlite, { schema })
  if (opts.bootstrap !== 'required') legacyDaemonTestDbs.add(db as object)
  return db
}
