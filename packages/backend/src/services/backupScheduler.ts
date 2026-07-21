// RFC-213 PR-3 — scheduled backup + retention + pre-migration safety net.
//
// - startBackupScheduler: an interval ticker (reentrancy-guarded, like the GC /
//   orphan-reconcile loops) that fires createBackup + prunes old ones.
// - pruneBackups: KEEP a scheduled/auto backup iff it is within the newest N OR
//   newer than D days; DELETE only when it fails BOTH. Manual + pre-restore +
//   pre-migration backups are NEVER auto-pruned. Never deletes the last backup.
// - maybePreMigrationBackup: before boot migrations, raw-copy the DB so a botched
//   upgrade can be rolled back (rawCopyDb, NOT createBackup — the OLD schema
//   can't be SELECTed by the NEW binary).

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { createBackup } from '@/services/backup'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { readDbMigrationIdentity, readMigrationAxisFromJournal } from './backupManifest'
import { rawCopyDb } from './rawDbSnapshot'

const log = createLogger('backupScheduler')

/** A rotatable (auto-pruned) backup is one createBackup wrote for a scheduled /
 *  auto run. Manual (`agent-workflow-…`) and pre-* backups are protected. */
function isRotatable(name: string): boolean {
  return name.startsWith('scheduled-') || name.startsWith('auto-')
}

export interface PruneOptions {
  dir: string
  count: number
  days: number
  now: number
}

export interface PruneResult {
  deleted: string[]
  kept: string[]
}

/** Apply the retention policy to a backups directory. Pure w.r.t. inputs (reads
 *  the dir, deletes files), returns what it did. */
export function pruneBackups(opts: PruneOptions): PruneResult {
  const { dir, count, days, now } = opts
  let files: { name: string; path: string; mtime: number }[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const p = join(dir, f)
        return { name: f, path: p, mtime: statSync(p).mtimeMs }
      })
  } catch {
    return { deleted: [], kept: [] }
  }

  const rotatable = files.filter((f) => isRotatable(f.name)).sort((a, b) => b.mtime - a.mtime)
  const cutoff = now - days * 86_400_000
  const toDelete = rotatable.filter((f, idx) => {
    const withinCount = idx < count
    const withinDays = f.mtime > cutoff
    return !withinCount && !withinDays // DELETE only when it fails BOTH
  })

  // Never delete the last backup on disk (protected ones usually survive; this
  // covers the all-rotatable-and-old case).
  if (files.length - toDelete.length <= 0 && toDelete.length > 0) {
    toDelete.sort((a, b) => b.mtime - a.mtime)
    toDelete.shift() // keep the newest of the would-be-deleted set
  }

  const deleted: string[] = []
  for (const f of toDelete) {
    try {
      unlinkSync(f.path)
      deleted.push(f.name)
    } catch (err) {
      log.warn('prune: unlink failed', { file: f.name, error: (err as Error).message })
    }
  }
  return { deleted, kept: files.filter((f) => !deleted.includes(f.name)).map((f) => f.name) }
}

export interface BackupSchedulerOptions {
  db: DbClient
  intervalMs: number
  retentionCount: number
  retentionDays: number
  appHome?: string
}

export interface BackupSchedulerHandle {
  stop: () => void
}

/** Start the periodic backup ticker. intervalMs <= 0 → no-op (disabled). */
export function startBackupScheduler(opts: BackupSchedulerOptions): BackupSchedulerHandle {
  if (!opts.intervalMs || opts.intervalMs <= 0) return { stop: () => {} }
  const appHome = opts.appHome ?? Paths.root
  let running = false // reentrancy guard: a slow createBackup must not overlap
  const handle = setInterval(() => {
    if (running) return
    running = true
    ;(async () => {
      await createBackup({ db: opts.db, kind: 'scheduled', appHome })
      pruneBackups({
        dir: join(appHome, 'backups'),
        count: opts.retentionCount,
        days: opts.retentionDays,
        now: Date.now(),
      })
    })()
      .catch((err) => log.warn('backup tick threw', { error: (err as Error).message }))
      .finally(() => {
        running = false
      })
  }, opts.intervalMs)
  ;(handle as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(handle) }
}

/** RFC-213 G4c — one `wal_checkpoint(TRUNCATE)` on the live DB. Exported so the
 *  truncation behaviour is unit-tested directly (the ticker is just a timer). */
export function checkpointWal(db: DbClient): void {
  const sqlite = (db as unknown as { $client: { exec: (s: string) => void } }).$client
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
}

export interface WalCheckpointOptions {
  db: DbClient
  intervalMs: number
}

/** Periodically checkpoint(TRUNCATE) the WAL to bound -wal growth. 0 = off. */
export function startWalCheckpointLoop(opts: WalCheckpointOptions): BackupSchedulerHandle {
  if (!opts.intervalMs || opts.intervalMs <= 0) return { stop: () => {} }
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    try {
      checkpointWal(opts.db)
    } catch (err) {
      log.warn('wal checkpoint failed', { error: (err as Error).message })
    } finally {
      running = false
    }
  }, opts.intervalMs)
  ;(handle as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(handle) }
}

export interface PreMigrationBackupOptions {
  appHome: string
  dbPath: string
  migrationsFolder: string
  enabled: boolean
  now?: number
}

/**
 * If there are pending migrations (the DB's newest applied `created_at` is older
 * than the binary's newest `_journal.json` `when`), raw-copy the DB first so a
 * botched upgrade is recoverable. Returns the backup path, or null when skipped
 * (disabled / fresh install / already up to date).
 */
export async function maybePreMigrationBackup(
  opts: PreMigrationBackupOptions,
): Promise<string | null> {
  if (!opts.enabled) return null
  if (!existsSync(opts.dbPath)) return null // fresh install — nothing to lose
  const dbMax = readDbMigrationIdentity(opts.dbPath)?.lastCreatedAt ?? -1
  const binaryMax = readMigrationAxisFromJournal(opts.migrationsFolder).maxWhen
  if (dbMax >= binaryMax) return null // up to date — no pending migration
  const r = await rawCopyDb({
    kind: 'pre-migration',
    appHome: opts.appHome,
    dbPath: opts.dbPath,
    filenameStem: `pre-migration-${dbMax}-${binaryMax}`,
    now: opts.now,
  })
  log.info('pre-migration backup written', { path: r.path, from: dbMax, to: binaryMax })
  return r.path
}
