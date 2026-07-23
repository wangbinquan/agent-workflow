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
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import { quickCheckDbFile } from '@/db/integrity'
import { recordRecoveryEvent } from '@/services/recovery'
import { extractTarGz, tarGz } from '@/util/archive'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import {
  type BackupManifest,
  currentAppVersion,
  readManifest,
  readMigrationAxisFromJournal,
} from './backupManifest'
import { rawCopyDb } from './rawDbSnapshot'
import { reconstructWorktrees } from './worktreeBackup'

const log = createLogger('restore')

export type RestoreDirection = 'same' | 'forward' | 'downgrade'

/** `--no-migrate` may deliberately expose a pre-0117 schema to an older binary. */
function hasFusionProvenanceSchema(db: DbClient): boolean {
  const raw = (db as unknown as { $client: Database }).$client
  const fusionColumns = new Set(
    (
      raw.query("SELECT name FROM pragma_table_info('fusions')").all() as Array<{ name: string }>
    ).map((column) => column.name),
  )
  const memoryColumns = new Set(
    (
      raw.query("SELECT name FROM pragma_table_info('memories')").all() as Array<{ name: string }>
    ).map((column) => column.name),
  )
  return fusionColumns.has('skill_id') && memoryColumns.has('fused_into_skill_id')
}

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

// RFC-213 impl-gate P0-1 (Codex 2026-07-22): thrown when a step AFTER the DB
// swap fails. The live DB is now the restored generation, so the boot MUST NOT
// silently fall back to "give up on the staged restore, boot the still-healthy
// DB" (that healthy DB no longer exists at dbPath). applyPendingRestoreIfAny
// rethrows this so the daemon fail-closes instead of booting a mixed state.
export class RestorePostSwapError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `restore FAILED AFTER swapping in the new database ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). The live DB is now the ` +
        `restored generation but post-swap steps (config/skills copy, migrate, worktree ` +
        `reconstruct, task suspend) did not finish — the instance is in a mixed state and must ` +
        `NOT boot on it. Recover from the pre-restore safety backup, then retry`,
    )
    this.name = 'RestorePostSwapError'
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
  /** Test-only fault-injection seam: invoked immediately AFTER the DB swap so a
   *  test can force a post-swap failure and assert the RestorePostSwapError /
   *  fail-closed path (P0-1). Never set in production. */
  __afterSwapForTest?: () => void | Promise<void>
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

/**
 * Impl-gate P1-1 (2026-07-22) — FULL entry validation before STAGING a hot
 * restore. `planRestore` only reads the manifest; a staged tarball that later
 * failed `restoreBackup` on boot used to loop forever: marker + tarball survive
 * a failed apply, so every startup re-failed identically until someone hand-rm'd
 * `.restore-pending/` (which no error message mentioned). Validate here exactly
 * what the boot apply will enforce — db.sqlite present, WAL consolidated,
 * quick_check (unless the caller passes the same escape hatch it will stage),
 * downgrade refused — so a bad upload is rejected at the door with the daemon
 * still healthy. (Boot-side failures are additionally self-healing now — see
 * applyPendingRestoreIfAny — but door-front rejection is the primary defence.)
 */
export async function validateBackupForStage(
  tarballPath: string,
  opts: { migrationsFolder?: string; appHome?: string; skipIntegrityCheck?: boolean } = {},
): Promise<RestorePlan> {
  const appHome = opts.appHome ?? Paths.root
  const staging = join(appHome, 'backups', `.stage-validate-${Date.now()}-${process.pid}`)
  mkdirSync(staging, { recursive: true })
  try {
    await extractTarGz(tarballPath, staging)
    const manifest = readManifest(staging)
    const currentMaxWhen = readMigrationAxisFromJournal(
      opts.migrationsFolder ?? Paths.migrationsDir,
    ).maxWhen
    const backupLastCreatedAt = manifest?.migration.lastCreatedAt ?? null
    const direction = computeRestoreDirection(backupLastCreatedAt, currentMaxWhen)
    if (direction === 'downgrade') {
      throw new RestoreDowngradeError(backupLastCreatedAt!, currentMaxWhen)
    }
    const incomingDb = join(staging, 'db.sqlite')
    if (!existsSync(incomingDb)) {
      throw new Error('stage refused: backup contains no db.sqlite (not a backup tarball?)')
    }
    if (existsSync(`${incomingDb}-wal`)) {
      try {
        const c = new Database(incomingDb, { readwrite: true })
        c.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        c.close()
      } catch {
        /* corrupt — quick_check below will refuse it */
      }
    }
    if (opts.skipIntegrityCheck !== true) {
      const check = quickCheckDbFile(incomingDb)
      if (!check.ok) throw new RestoreIntegrityError(check.errors)
    }
    assertBackupSkillsPayload(staging, incomingDb, 'stage refused')
    return { manifest, backupLastCreatedAt, currentMaxWhen, direction }
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

// Non-terminal (still-active / recoverable) task statuses. Terminal = done /
// failed / canceled. Kept local so restore doesn't couple to the lifecycle module.
const NON_TERMINAL_TASK_STATUSES = [
  'running',
  'pending',
  'awaiting_review',
  'awaiting_human',
  'interrupted',
] as const

/**
 * RFC-213 G4a — after a restore, set `auto_recovery_suspended = 1` on every
 * non-terminal task so the auto-resume / auto-repair loops skip them (they may be
 * paired with an on-disk worktree that no longer matches the restored row).
 * Returns how many rows were suspended.
 */
function suspendNonTerminalTasksAfterRestore(db: DbClient): number {
  const sqlite = (db as unknown as { $client: Database }).$client
  const placeholders = NON_TERMINAL_TASK_STATUSES.map(() => '?').join(',')
  const res = sqlite
    .query(
      `UPDATE tasks SET auto_recovery_suspended = 1 ` +
        `WHERE auto_recovery_suspended = 0 AND status IN (${placeholders})`,
    )
    .run(...NON_TERMINAL_TASK_STATUSES)
  return res.changes
}

/**
 * Impl-gate P1-4 — safety copy of the FILESYSTEM state a restore destroys:
 * config.json (overwritten) + skills/ (deleted then replaced; its source of
 * truth IS the filesystem). Bundled as `pre-restore-fs-<ts>.tar.gz` next to the
 * DB safety copy. Fail-closed like the DB copy (caller wraps in
 * RestoreSafetyBackupError). Returns the tarball path, or null when neither
 * exists (fresh home — nothing to protect).
 */
async function snapshotFsStateForSafety(appHome: string, now: number): Promise<string | null> {
  const config = join(appHome, 'config.json')
  const skills = join(appHome, 'skills')
  if (!existsSync(config) && !existsSync(skills)) return null
  const backupsDir = join(appHome, 'backups')
  mkdirSync(backupsDir, { recursive: true })
  const staging = join(backupsDir, `.pre-restore-fs-${now}-${process.pid}`)
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    if (existsSync(config)) cpSync(config, join(staging, 'config.json'))
    if (existsSync(skills)) cpSync(skills, join(staging, 'skills'), { recursive: true })
    const out = join(backupsDir, `pre-restore-fs-${now}.tar.gz`)
    await tarGz(staging, out)
    return out
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
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

    // RFC-223 PR-5: an old DB and its name-keyed skills tree are one restore
    // generation. After 0116 has renamed live roots to immutable ids, restoring
    // a DB-only old backup while retaining the current tree strands every
    // managed_path/files_path. Refuse before the live DB swap. A truly empty DB
    // remains a valid DB-only backup.
    assertBackupSkillsPayload(staging, incomingDb, 'restore refused')

    // Pre-restore safety backup (raw byte copy — tolerates a corrupt current DB).
    // Fail-closed: if it throws (disk full / tar fail), abort before any swap.
    let safetyBackupPath: string | null = null
    if (!opts.noSafetyBackup) {
      try {
        const safety = await rawCopyDb({ kind: 'pre-restore', appHome, dbPath, now })
        safetyBackupPath = safety.path
        // Impl-gate P1-4 (2026-07-22): config.json is overwritten and skills/
        // (whose SOURCE OF TRUTH is the filesystem) is DELETED below — without a
        // safety copy, "误恢复也能再翻回来" (US-2) held for the DB only. Same
        // fail-closed contract as the DB safety copy.
        await snapshotFsStateForSafety(appHome, now)
      } catch (err) {
        throw new RestoreSafetyBackupError(err)
      }
    }

    swapInDbFile(incomingDb, dbPath)

    // Impl-gate P0-1 (Codex 2026-07-22): PAST THIS POINT the live DB is the
    // restored generation. Any failure here is NOT "the current data is
    // untouched" — the boot must fail-closed rather than silently continue on a
    // DB that no longer matches config/skills/migrations. Wrap every post-swap
    // step so its error is tagged RestorePostSwapError and applyPendingRestoreIfAny
    // can distinguish it from a pre-swap refusal.
    try {
      // Test-only seam to force a post-swap failure (never set in production).
      if (opts.__afterSwapForTest !== undefined) await opts.__afterSwapForTest()

      // Filesystem-sourced state (NOT in the DB): config.json + skills/. Workflows
      // ride in the DB (just swapped), so their YAML in the tarball is redundant here.
      const restored = { db: true, config: false, skills: false }
      const stagedConfig = join(staging, 'config.json')
      if (existsSync(stagedConfig)) {
        cpSync(stagedConfig, join(appHome, 'config.json'))
        restored.config = true
      }
      const stagedSkills = join(staging, 'skills')
      const liveSkills = join(appHome, 'skills')
      // The filesystem is part of the restored generation even when that
      // generation is intentionally empty. Never retain newer live skill roots
      // beside an incoming DB with zero skill rows.
      rmSync(liveSkills, { recursive: true, force: true })
      if (isRealDirectory(stagedSkills)) {
        cpSync(stagedSkills, liveSkills, { recursive: true })
        restored.skills = true
      }

      // Forward-migrate the swapped-in DB (also re-runs the boot integrity gate).
      const migrated = willMigrate
      {
        // Impl-gate P1-2 (2026-07-22): thread the escape hatch through. Without
        // it, `--skip-integrity-check` skipped the INCOMING gate but openDb's own
        // quick_check then threw AFTER the swap — the flag's whole purpose
        // (salvage a quick_check-failing but readable backup) self-defeated, and
        // the abort landed mid-restore (DB swapped, suspend/reconstruct skipped).
        const db = openDb({
          path: dbPath,
          migrationsFolder,
          skipMigrations: !willMigrate,
          skipIntegrityCheck: opts.skipIntegrityCheck,
        })
        // RFC-223 PR-5: filesystem state was copied just before openDb and the
        // restored DB has now been forward-migrated. Reuse the exact boot
        // barrier before any restored task/state is exposed or the DB closes;
        // absolute legacy op paths are rebased to this restore's appHome.
        if (willMigrate || direction === 'same') {
          const { runSkillIdentityMigrationBarrier } =
            await import('@/services/skillIdentityMigration')
          runSkillIdentityMigrationBarrier(db, { appHome })
        }
        // RFC-223 PR-4: SQL can recover committed fusion versions, while
        // in-flight legacy rows require decoding their launch-time token in
        // application code. Run the same fail-closed repair as normal boot
        // before this forward-restored DB can be exposed.
        if (hasFusionProvenanceSchema(db)) {
          const { repairFusionProvenance } = await import('@/services/fusion')
          repairFusionProvenance(db)
        }
        // RFC-213 G4a mismatch-protect: the restored rows are backup-era, but the
        // on-disk worktrees are current. Suspend auto-recovery for every non-terminal
        // task so the auto-resume loop can't silently roll a NEWER worktree back to a
        // STALE pre_snapshot (design gate). Manual resume stays the user's informed
        // choice; auto-resume is blocked until they clear the suspension.
        const suspended = suspendNonTerminalTasksAfterRestore(db)
        // RFC-213 G4a: reconstruct any non-terminal task worktree that the backup
        // captured and is now MISSING on disk (same-machine, inspection/salvage).
        const wt = manifest?.includesWorktrees ? await reconstructWorktrees(db, staging) : null
        await recordRecoveryEvent(db, {
          kind: 'restore',
          reason: `restored ${tarballPath} (direction=${direction}, ${migrated ? 'migrated' : 'no-migrate'})`,
          after: {
            safetyBackupPath,
            direction,
            suspendedTasks: suspended,
            worktreesReconstructed: wt?.reconstructed.length ?? 0,
          },
          now,
        })
        ;(db as unknown as { $client: Database }).$client.close()
      }

      log.info('restore complete', { tarballPath, direction, migrated, safetyBackupPath })
      return { direction, safetyBackupPath, migrated, restored }
    } catch (err) {
      if (err instanceof RestorePostSwapError) throw err
      throw new RestorePostSwapError(err)
    }
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

function dbHasSkillRows(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true })
  try {
    const table = db
      .query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='skills' LIMIT 1")
      .get()
    if (table === null) return false
    return db.query('SELECT 1 AS present FROM skills LIMIT 1').get() !== null
  } finally {
    db.close()
  }
}

function assertBackupSkillsPayload(
  staging: string,
  incomingDb: string,
  prefix: 'stage refused' | 'restore refused',
): void {
  // Filesystem-first short circuit is load-bearing for corruption salvage:
  // when a real payload is present, --skip-integrity-check must not query a
  // damaged but potentially recoverable DB merely to validate this invariant.
  if (isRealDirectory(join(staging, 'skills'))) return
  if (dbHasSkillRows(incomingDb)) {
    throw new Error(
      `${prefix}: backup contains skill rows but no matching skills filesystem payload`,
    )
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
