// SQLite + Drizzle client + auto-migration on startup.
// Used by the daemon's main entry; tests use createInMemoryDb().

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema'

export type DbClient = ReturnType<typeof drizzle<typeof schema>>

export interface OpenDbOptions {
  /** Absolute path to the sqlite file. */
  path: string
  /** Path to the migrations folder. */
  migrationsFolder: string
  /** Skip running migrations on open (mainly for tests that inject schema directly). */
  skipMigrations?: boolean
}

/**
 * Open the daemon's primary database. Creates the parent directory if missing,
 * applies WAL + busy_timeout per design.md §11, and runs all pending Drizzle
 * migrations from the bundled migrations folder.
 */
export function openDb(opts: OpenDbOptions): DbClient {
  mkdirSync(dirname(opts.path), { recursive: true })

  const sqlite = new Database(opts.path, { create: true })
  // Per design.md §11.0 SQLite settings: WAL + NORMAL + 5s busy timeout.
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA synchronous = NORMAL;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
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
    const violations = sqlite.query('PRAGMA foreign_key_check;').all()
    if (violations.length > 0) {
      throw new Error(`post-migration foreign_key_check failed: ${JSON.stringify(violations)}`)
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
