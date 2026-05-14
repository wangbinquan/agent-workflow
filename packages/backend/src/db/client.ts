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
  sqlite.exec('PRAGMA foreign_keys = ON;')

  const db = drizzle(sqlite, { schema })

  if (!opts.skipMigrations) {
    migrate(db, { migrationsFolder: resolve(opts.migrationsFolder) })
  }

  return db
}

/**
 * Open an in-memory database with all migrations applied.
 * Used by bun:test integration tests; no fs side-effects.
 */
export function createInMemoryDb(migrationsFolder: string): DbClient {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve(migrationsFolder) })
  return db
}
