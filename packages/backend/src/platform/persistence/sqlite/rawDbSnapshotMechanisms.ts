// RFC-349 — SQLite-owned mechanisms for the corruption-tolerant raw snapshot.
//
// The filesystem/archive orchestration remains in the legacy snapshot service,
// while opening SQLite, checkpointing WAL and inspecting migration/integrity
// state stay behind this provider-private adapter. PostgreSQL backup/restore
// never reaches this module.

import { Database } from 'bun:sqlite'
import { quickCheckDbFile, type IntegrityResult } from '@/db/integrity'
import { readDbMigrationIdentity, type MigrationIdentity } from './systemBackupManifest'

export interface SqliteRawDbSnapshotMechanisms {
  checkpoint(dbPath: string): boolean
  readMigrationIdentity(dbPath: string): MigrationIdentity | null
  quickCheck(dbPath: string, hasWal: boolean): IntegrityResult
}

export const sqliteRawDbSnapshotMechanisms: SqliteRawDbSnapshotMechanisms = {
  checkpoint(dbPath) {
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readwrite: true })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      return true
    } catch {
      // Corrupt / locked / missing: the safety path still copies raw bytes.
      return false
    } finally {
      db?.close()
    }
  },
  readMigrationIdentity: readDbMigrationIdentity,
  // Existing WAL frames must remain untouched: a readwrite connection can
  // checkpoint them on close. Only a bare copy needs writable auxiliary files.
  quickCheck: (dbPath, hasWal) => quickCheckDbFile(dbPath, { allowWalSidecarCreation: !hasWal }),
}
