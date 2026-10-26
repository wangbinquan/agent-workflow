// RFC-395: the original SQLite receipt protocol, applied only to offline copies.
import type { Database } from 'bun:sqlite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import {
  rewriteLegacyOrderedJsonAggregates,
  sqliteSupportsOrderedJsonAggregates,
} from '../legacy/sqliteCompatibility'

export function createFrozenSqliteJournal(database: Database): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
}
export function applyFrozenSqliteMigrations(
  database: Database,
  migrations: readonly MigrationMeta[],
): void {
  // RFC-115: DROP during rebuild must never cascade into source child rows.
  database.exec('PRAGMA foreign_keys = OFF')
  const orderedJson = sqliteSupportsOrderedJsonAggregates(database)
  database.exec('BEGIN')
  try {
    for (const migration of migrations) {
      for (const statement of migration.sql)
        database.exec(orderedJson ? statement : rewriteLegacyOrderedJsonAggregates(statement))
      database
        .query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(migration.hash, migration.folderMillis)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
