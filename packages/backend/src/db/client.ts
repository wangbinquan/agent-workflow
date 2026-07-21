// SQLite + Drizzle client + auto-migration on startup.
// Used by the daemon's main entry; tests use createInMemoryDb().

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema'

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
    // RFC-205 D9 — best-effort 0600, matching secret.key: the DB holds every
    // sealed credential and umask-default perms leak it to other local users.
    // (Same-uid agents are handled by the sandbox, not by mode bits.)
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

  if (!opts.skipMigrations) {
    // RFC-115 (Codex audit F1): run migrations with foreign_keys OFF. drizzle
    // wraps ALL migrations in ONE transaction, and `PRAGMA foreign_keys` is a
    // no-op INSIDE a transaction — so a 12-step rebuild's own
    // `PRAGMA foreign_keys=OFF` never takes effect and its `DROP TABLE <x>`
    // cascade-deletes child rows on upgrade (0058 DROP doc_versions →
    // review_comments wiped via ON DELETE cascade; 0035/0041 are the same shape
    // for node_runs). Toggle OUTSIDE drizzle's tx, then re-enable + verify.
    sqlite.exec('PRAGMA foreign_keys = OFF;')
    migrate(db, { migrationsFolder: resolve(opts.migrationsFolder) })
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
  }
  sqlite.exec('PRAGMA foreign_keys = ON;')

  return db
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
export function createInMemoryDb(migrationsFolder: string): DbClient {
  const sqlite = Database.deserialize(migratedSnapshot(migrationsFolder))
  sqlite.exec('PRAGMA foreign_keys = ON;')
  return drizzle(sqlite, { schema })
}
