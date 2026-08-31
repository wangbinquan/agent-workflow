// RFC-349 — crash-safe raw SQLite rollback snapshot. The heavy VACUUM INTO
// runs on the existing backup worker; the operation directory receives the
// file only after integrity verification and atomic replacement.

import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseMigrationSafetyBackupPort } from '../application/databaseMigrationRunner'
import { vacuumIntoOffThread } from '@/services/backup'

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return `sha256:${hash.digest('hex')}`
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Some Windows/filesystem combinations cannot fsync a directory.
  }
}

function verifySqlite(path: string): void {
  const db = new Database(path, { readonly: true })
  try {
    const rows = db.query('PRAGMA quick_check').all() as { quick_check: string }[]
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      throw new Error('SQLite migration safety backup failed quick_check')
    }
  } finally {
    db.close()
  }
}

export function createSqliteMigrationSafetyBackup(): DatabaseMigrationSafetyBackupPort {
  const port: DatabaseMigrationSafetyBackupPort = {
    async create(input) {
      const destination = join(input.operationRoot, 'source-backup', 'db.sqlite')
      if (existsSync(destination)) {
        verifySqlite(destination)
        return { path: destination, digest: await digestFile(destination) }
      }
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
      const source = new Database(input.sourcePath, { readonly: true })
      try {
        await vacuumIntoOffThread(source, input.sourcePath, temporary)
      } finally {
        source.close()
      }
      try {
        verifySqlite(temporary)
        const handle = openSync(temporary, 'r')
        try {
          fsyncSync(handle)
        } finally {
          closeSync(handle)
        }
        renameSync(temporary, destination)
        try {
          chmodSync(destination, 0o600)
        } catch {
          // Non-POSIX filesystems still retain the atomic snapshot contract.
        }
        fsyncDirectory(dirname(destination))
        verifySqlite(destination)
        return { path: destination, digest: await digestFile(destination) }
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true })
      }
    },
  }
  return Object.freeze(port)
}
