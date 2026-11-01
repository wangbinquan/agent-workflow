import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

/**
 * RFC-398 §5: a checkpointed WAL database may have no sidecars. Allow SQLite to
 * create them without creating a missing database. An existing WAL must remain
 * read-only so closing this reader cannot checkpoint somebody else's writes.
 * This helper issues no SQL; callers must only read the source database.
 */
export function openSqliteForRead(path: string): Database {
  return existsSync(`${path}-wal`)
    ? new Database(path, { readonly: true })
    : new Database(path, { readwrite: true, create: false })
}
