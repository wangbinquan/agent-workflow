import type { Database } from 'bun:sqlite'
import { SchemaHistoryError } from '../schema/history/types'
import { sqliteHistoryConnection, type HistoryConnection } from '../schema/history/connection'
import { collectSqliteHistoryCatalog } from './historyCatalog'
import type { HistorySession } from '../schema/history/session'
export async function sqliteHistoryTransaction<T>(
  database: Database,
  body: (connection: HistoryConnection) => Promise<T>,
): Promise<T> {
  if (database.inTransaction)
    throw new SchemaHistoryError(
      'nested-transaction',
      'FK mode must be changed outside the history transaction',
    )
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!
    .foreign_keys
  const legacyAlterTable = database
    .query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table')
    .get()!.legacy_alter_table
  database.exec('PRAGMA foreign_keys = OFF')
  // Bun may default to legacy rename rules. Modern rename updates self-FKs as
  // the rebuilt table takes its final name; restore the caller's setting below.
  database.exec('PRAGMA legacy_alter_table = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      const applied = await body(sqliteHistoryConnection(database))
      if (database.query('PRAGMA foreign_key_check').all().length)
        throw new SchemaHistoryError(
          'foreign-key-check',
          'history edge introduces an invalid foreign key',
        )
      database.exec('COMMIT')
      return applied
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    database.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable ? 'ON' : 'OFF'}`)
    database.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}
export function sqliteHistorySession(database: Database): HistorySession {
  return {
    transaction: (body) => sqliteHistoryTransaction(database, body),
    read: (body) =>
      body(sqliteHistoryConnection(database), async () => collectSqliteHistoryCatalog(database)),
  }
}
