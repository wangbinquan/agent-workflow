// RFC-213 — raw, corruption-tolerant DB snapshot.
//
// This is the safety-net backup used where createBackup CANNOT run:
//   - pre-restore  (the current DB may be the corrupt one being restored away
//                   from; VACUUM INTO throws SQLITE_CORRUPT on it),
//   - pre-migration (createBackup's listWorkflows SELECTs columns the NEW binary
//                    declares but the OLD unmigrated DB lacks → `no such column`).
//
// It NEVER opens the DB for a schema-shaped query and NEVER VACUUMs: it does a
// best-effort WAL checkpoint (skipped silently if the DB won't open) and then a
// pure BYTE copy of db.sqlite (+ -wal/-shm when present). A byte copy is immune
// to SQLITE_CORRUPT and preserves even a broken file for forensics.
//
// Design gate (design/RFC-213-disaster-recovery/design.md §3.1) mandated this
// split from createBackup (services/backup.ts, VACUUM INTO — healthy DB only).

import { Database } from 'bun:sqlite'
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { quickCheckDbFile } from '@/db/integrity'
import { tarGz } from '@/util/archive'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import {
  type BackupKind,
  type BackupManifest,
  currentAppVersion,
  readDbMigrationIdentity,
  writeManifest,
} from './backupManifest'

const log = createLogger('rawDbSnapshot')

// RFC-213 impl-gate P0-4 (Codex 2026-07-22): best-effort fsync so the safety
// tarball is DURABLE before the caller (restore) deletes the old WAL and swaps
// the DB. Mirror of the same helpers in restore.ts (kept local to avoid a
// restore↔rawDbSnapshot import cycle; both are trivial + stable).
function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* best-effort — some platforms reject directory fsync; durability only */
  }
}

export interface RawCopyOptions {
  kind: BackupKind
  /** Override app home (tests). Defaults to Paths.root. */
  appHome?: string
  /** Override the source DB path (tests). Defaults to Paths.db. */
  dbPath?: string
  /** Override `now` for deterministic filenames (tests). */
  now?: number
  /** Best-effort `wal_checkpoint(TRUNCATE)` before the copy. Default true; a
   *  corrupt/locked DB just skips it. */
  checkpoint?: boolean
  /** Filename stem before the timestamp. Defaults to `kind` (e.g.
   *  `pre-migration-104-105`). */
  filenameStem?: string
}

export interface RawCopyResult {
  path: string
  sizeBytes: number
  /** Which of the three sqlite files were present + copied. */
  copied: { db: boolean; wal: boolean; shm: boolean }
  /** Whether the best-effort checkpoint actually ran (false = DB unreadable). */
  checkpointed: boolean
}

function stampForFilename(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
}

/**
 * Byte-copy the sqlite DB (+ WAL/SHM) into a tar.gz under `${appHome}/backups/`.
 * Corruption-tolerant: never throws on a bad DB (only on I/O failure writing the
 * tarball). The pre-restore caller treats a THROW (e.g. disk full) as fatal
 * (fail-closed) unless the user passed --no-safety-backup.
 */
export async function rawCopyDb(opts: RawCopyOptions): Promise<RawCopyResult> {
  const appHome = opts.appHome ?? Paths.root
  const dbPath = opts.dbPath ?? join(appHome, 'db.sqlite')
  const backupsDir = join(appHome, 'backups')
  mkdirSync(backupsDir, { recursive: true })

  const ts = stampForFilename(opts.now ?? Date.now())
  const stem = opts.filenameStem ?? opts.kind
  const stagingDir = join(backupsDir, `.raw-staging-${stem}-${ts}`)
  const outPath = join(backupsDir, `${stem}-${ts}.tar.gz`)
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  // Best-effort checkpoint: fold WAL frames into the main file so a copy of
  // db.sqlite alone is self-contained. Silently skipped on a DB we can't open.
  let checkpointed = false
  if (opts.checkpoint !== false) {
    let ck: Database | null = null
    try {
      ck = new Database(dbPath, { readwrite: true })
      ck.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      checkpointed = true
    } catch {
      // corrupt / locked / missing — copy the raw files as-is.
    } finally {
      ck?.close()
    }
  }

  // Read migration identity BEFORE copy (best-effort; null on corrupt).
  const identity = readDbMigrationIdentity(dbPath) ?? { lastHash: null, lastCreatedAt: null }

  const copied = { db: false, wal: false, shm: false }
  try {
    if (existsSync(dbPath)) {
      cpSync(dbPath, join(stagingDir, 'db.sqlite'))
      copied.db = true
      // Impl-gate P2-19 (AC-2): verify the copy — a torn / zero-byte copy
      // silently defeats the whole safety net exactly when it matters. Size
      // must match the source; quick_check is best-effort WARN only (the
      // source may legitimately be the corrupt DB being restored away from).
      const srcSize = statSync(dbPath).size
      const copySize = statSync(join(stagingDir, 'db.sqlite')).size
      if (copySize !== srcSize || copySize === 0) {
        throw new Error(`raw db copy verification failed (src=${srcSize}B copy=${copySize}B)`)
      }
      if (checkpointed) {
        const chk = quickCheckDbFile(join(stagingDir, 'db.sqlite'))
        if (!chk.ok) {
          log.warn('raw db copy fails quick_check (copying anyway — may be the point)', {
            errors: chk.errors.slice(0, 3),
          })
        }
      }
    }
    // -wal / -shm may or may not exist depending on checkpoint success and
    // whether the daemon closed cleanly. Copy whatever is there.
    if (existsSync(`${dbPath}-wal`)) {
      cpSync(`${dbPath}-wal`, join(stagingDir, 'db.sqlite-wal'))
      copied.wal = true
    }
    if (existsSync(`${dbPath}-shm`)) {
      cpSync(`${dbPath}-shm`, join(stagingDir, 'db.sqlite-shm'))
      copied.shm = true
    }

    const manifest: BackupManifest = {
      manifestVersion: 1,
      kind: opts.kind,
      createdAt: opts.now ?? Date.now(),
      appVersion: currentAppVersion(),
      includesWorktrees: false,
      migration: identity,
    }
    writeManifest(stagingDir, manifest)

    await tarGz(stagingDir, outPath)
    // P0-4: land the safety tarball + its directory entry durably BEFORE the
    // caller destroys the old DB generation. Without this, a power loss after the
    // pre-restore copy but before the swap's fsync could lose BOTH the safety
    // tarball (still buffered) and the old WAL (already unlinked by swapInDbFile).
    fsyncPath(outPath)
    fsyncPath(backupsDir)
    log.info('raw db snapshot created', { path: outPath, kind: opts.kind, checkpointed, copied })
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  }

  return { path: outPath, sizeBytes: statSync(outPath).size, copied, checkpointed }
}
