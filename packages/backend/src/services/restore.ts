// RFC-213 PR-1a — cold restore (daemon stopped).
//
// Rehydrates ~/.agent-workflow from a backup tarball produced by createBackup or
// rawCopyDb. Every mechanism here is a design-gate correction of the v1 draft
// (design/RFC-213-disaster-recovery/design.md §3, §10 订正账):
//
//   - safety backup = rawCopyDb (byte copy), NOT createBackup — the current DB
//     may be the corrupt one being restored away from;
//   - version gate = MIGRATION IDENTITY (created_at vs _journal.json `when`),
//     NOT a .sql count (which is 0 in the single-binary);
//   - crash-safe swap = delete -wal/-shm FIRST, then rename, then fsync — else a
//     stale WAL replays onto the new DB and silently corrupts it;
//   - pre-migration backups are binary-pinned: forward-rolling one onto a
//     different binary just re-runs the migration that broke it.

import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { openDb } from '@/db/client'
import { quickCheckDbFile } from '@/db/integrity'
import { recordRecoveryEvent } from '@/services/recovery'
import { extractTarGz } from '@/util/archive'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import {
  type BackupManifest,
  currentAppVersion,
  readManifest,
  readMigrationAxisFromJournal,
} from './backupManifest'
import { rawCopyDb } from './rawDbSnapshot'

const log = createLogger('restore')

export type RestoreDirection = 'same' | 'forward' | 'downgrade'

export class RestoreDowngradeError extends Error {
  constructor(backupCreatedAt: number, currentMaxWhen: number) {
    super(
      `restore refused: backup is NEWER than this binary ` +
        `(backup migration ${backupCreatedAt} > binary ${currentMaxWhen}); ` +
        `you cannot downgrade — upgrade the binary or pick an older backup`,
    )
    this.name = 'RestoreDowngradeError'
  }
}

export class RestoreIntegrityError extends Error {
  constructor(public readonly checkErrors: string[]) {
    super(`restore refused: the backup DB failed integrity check: ${checkErrors.join('; ')}`)
    this.name = 'RestoreIntegrityError'
  }
}

export class RestoreSafetyBackupError extends Error {
  constructor(cause: unknown) {
    super(
      `restore aborted: the pre-restore safety backup failed ` +
        `(${cause instanceof Error ? cause.message : String(cause)}); ` +
        `the current data is untouched. Pass --no-safety-backup to override`,
    )
    this.name = 'RestoreSafetyBackupError'
  }
}

export class RestorePreMigrationBinaryError extends Error {
  constructor(backupVersion: string, currentVersion: string) {
    super(
      `restore refused: this is a pre-migration backup from binary ${backupVersion} ` +
        `but you are running ${currentVersion}. Forward-rolling it here would just ` +
        `re-run the migration that broke. Switch back to ${backupVersion} then ` +
        `\`restore --no-migrate\`, or pass --no-migrate to restore as-is`,
    )
    this.name = 'RestorePreMigrationBinaryError'
  }
}

export interface RestorePlan {
  manifest: BackupManifest | null
  backupLastCreatedAt: number | null
  currentMaxWhen: number
  direction: RestoreDirection
}

/** Pure decision: where does this backup sit relative to the running binary? */
export function computeRestoreDirection(
  backupLastCreatedAt: number | null,
  currentMaxWhen: number,
): RestoreDirection {
  // A legacy backup with no recorded identity is treated as older (forward).
  if (backupLastCreatedAt == null) return 'forward'
  if (backupLastCreatedAt > currentMaxWhen) return 'downgrade'
  if (backupLastCreatedAt === currentMaxWhen) return 'same'
  return 'forward'
}

export interface RestoreOptions {
  appHome?: string
  dbPath?: string
  /** Resolved migrations folder (dev: Paths.migrationsDir; embedded: the extracted
   *  runtime dir the caller prepared). Defaults to Paths.migrationsDir. */
  migrationsFolder?: string
  /** Skip the pre-restore safety backup (default false = take it, fail-closed). */
  noSafetyBackup?: boolean
  /** Restore the DB as-is without forward-migrating (for pre-migration rollback). */
  noMigrate?: boolean
  /** Skip the incoming-DB quick_check (escape hatch; default false). */
  skipIntegrityCheck?: boolean
  now?: number
}

export interface RestoreResult {
  direction: RestoreDirection
  safetyBackupPath: string | null
  migrated: boolean
  restored: { db: boolean; config: boolean; skills: boolean }
}

/** Extract a tarball's manifest without touching live state (for --dry-run). */
export async function planRestore(
  tarballPath: string,
  opts: { migrationsFolder?: string; appHome?: string } = {},
): Promise<RestorePlan> {
  const appHome = opts.appHome ?? Paths.root
  const staging = join(appHome, 'backups', `.plan-${Date.now()}-${process.pid}`)
  mkdirSync(staging, { recursive: true })
  try {
    await extractTarGz(tarballPath, staging)
    const manifest = readManifest(staging)
    const currentMaxWhen = readMigrationAxisFromJournal(
      opts.migrationsFolder ?? Paths.migrationsDir,
    ).maxWhen
    const backupLastCreatedAt = manifest?.migration.lastCreatedAt ?? null
    return {
      manifest,
      backupLastCreatedAt,
      currentMaxWhen,
      direction: computeRestoreDirection(backupLastCreatedAt, currentMaxWhen),
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function fsyncDir(dir: string): void {
  // Directory fsync for durability of the rename. Best-effort — some platforms
  // reject O_RDONLY fsync on a directory; the rename itself is still atomic.
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* best-effort */
  }
}

function fsyncFile(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Crash-safe DB swap. Order is load-bearing (design gate blocker #2): delete the
 * stale `-wal`/`-shm` FIRST, THEN rename the incoming file in, THEN fsync the
 * directory. Renaming first and deleting the WAL after leaves a window where a
 * stale WAL can replay onto the fresh DB by page number and silently corrupt it.
 * Exported so the sidecar-cleanup invariant is unit-tested directly (SQLite's own
 * WAL-mismatch detection masks it at the behavioural level).
 */
export function swapInDbFile(incomingDb: string, dbPath: string): void {
  fsyncFile(incomingDb)
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
  renameSync(incomingDb, dbPath)
  fsyncDir(dirname(dbPath))
}

/**
 * Cold restore. The daemon MUST be stopped (the caller checks the lock). Throws
 * on refusal (downgrade / integrity / safety-backup-failed / pre-migration
 * binary mismatch) BEFORE touching the live DB; once the swap begins it runs the
 * crash-safe sequence.
 */
export async function restoreBackup(
  tarballPath: string,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const appHome = opts.appHome ?? Paths.root
  const dbPath = opts.dbPath ?? join(appHome, 'db.sqlite')
  const migrationsFolder = opts.migrationsFolder ?? Paths.migrationsDir
  const now = opts.now ?? Date.now()

  const staging = join(appHome, 'backups', `.restore-staging-${now}-${process.pid}`)
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  try {
    await extractTarGz(tarballPath, staging)
    const manifest = readManifest(staging)
    const currentMaxWhen = readMigrationAxisFromJournal(migrationsFolder).maxWhen
    const backupLastCreatedAt = manifest?.migration.lastCreatedAt ?? null
    const direction = computeRestoreDirection(backupLastCreatedAt, currentMaxWhen)

    // Refusal checks BEFORE touching live state.
    if (direction === 'downgrade') {
      throw new RestoreDowngradeError(backupLastCreatedAt!, currentMaxWhen)
    }
    const willMigrate = !opts.noMigrate && direction === 'forward'
    if (
      manifest?.kind === 'pre-migration' &&
      willMigrate &&
      manifest.appVersion !== currentAppVersion()
    ) {
      throw new RestorePreMigrationBinaryError(manifest.appVersion, currentAppVersion())
    }

    const incomingDb = join(staging, 'db.sqlite')
    if (!existsSync(incomingDb)) {
      throw new Error('restore refused: backup contains no db.sqlite')
    }

    // Consolidate any WAL frames in the incoming copy (rawCopyDb of a
    // non-checkpointed DB carries them) so the swapped-in file is self-contained.
    if (existsSync(`${incomingDb}-wal`)) {
      try {
        const c = new Database(incomingDb, { readwrite: true })
        c.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        c.close()
      } catch {
        /* corrupt — quick_check below will refuse it */
      }
    }

    // Integrity gate on the INCOMING DB (restoring a corrupt backup over a
    // healthy DB is silent data loss).
    if (!opts.skipIntegrityCheck) {
      const check = quickCheckDbFile(incomingDb)
      if (!check.ok) throw new RestoreIntegrityError(check.errors)
    }

    // Pre-restore safety backup (raw byte copy — tolerates a corrupt current DB).
    // Fail-closed: if it throws (disk full / tar fail), abort before any swap.
    let safetyBackupPath: string | null = null
    if (!opts.noSafetyBackup) {
      try {
        const safety = await rawCopyDb({ kind: 'pre-restore', appHome, dbPath, now })
        safetyBackupPath = safety.path
      } catch (err) {
        throw new RestoreSafetyBackupError(err)
      }
    }

    swapInDbFile(incomingDb, dbPath)

    // Filesystem-sourced state (NOT in the DB): config.json + skills/. Workflows
    // ride in the DB (just swapped), so their YAML in the tarball is redundant here.
    const restored = { db: true, config: false, skills: false }
    const stagedConfig = join(staging, 'config.json')
    if (existsSync(stagedConfig)) {
      cpSync(stagedConfig, join(appHome, 'config.json'))
      restored.config = true
    }
    const stagedSkills = join(staging, 'skills')
    if (existsSync(stagedSkills)) {
      const liveSkills = join(appHome, 'skills')
      rmSync(liveSkills, { recursive: true, force: true })
      cpSync(stagedSkills, liveSkills, { recursive: true })
      restored.skills = true
    }

    // Forward-migrate the swapped-in DB (also re-runs the boot integrity gate).
    let migrated = false
    if (willMigrate) {
      const db = openDb({ path: dbPath, migrationsFolder })
      migrated = true
      await recordRecoveryEvent(db, {
        kind: 'restore',
        reason: `restored ${tarballPath} (direction=${direction}, migrated)`,
        after: { safetyBackupPath, direction },
        now,
      })
      ;(db as unknown as { $client: Database }).$client.close()
    } else {
      // no-migrate: still record the event on the (already-current-schema) DB.
      const db = openDb({ path: dbPath, migrationsFolder, skipMigrations: true })
      await recordRecoveryEvent(db, {
        kind: 'restore',
        reason: `restored ${tarballPath} (direction=${direction}, no-migrate)`,
        after: { safetyBackupPath, direction },
        now,
      })
      ;(db as unknown as { $client: Database }).$client.close()
    }

    log.info('restore complete', { tarballPath, direction, migrated, safetyBackupPath })
    return { direction, safetyBackupPath, migrated, restored }
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}
