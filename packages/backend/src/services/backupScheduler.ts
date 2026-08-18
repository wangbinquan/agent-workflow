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
  /** Impl-gate P2-6 — total-size cap over the ROTATABLE set (0/undefined = off). */
  maxTotalBytes?: number
  /** RFC-311 (proposal C4) — per-family cap for PROTECTED backups (manual
   *  `agent-workflow-*` and each `pre-*` family keep their newest N;
   *  0/undefined = never auto-prune them, the historical behavior). Production
   *  accumulated 59 files / 2GB because every binary upgrade adds a
   *  pre-migration tarball that nothing ever deleted (audit L3-2). */
  protectedKeepCount?: number
}

export interface PruneResult {
  deleted: string[]
  kept: string[]
}

/** Apply the retention policy to a backups directory. Pure w.r.t. inputs (reads
 *  the dir, deletes files), returns what it did. */
export function pruneBackups(opts: PruneOptions): PruneResult {
  const { dir, count, days, now } = opts
  let files: { name: string; path: string; mtime: number; size: number }[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const p = join(dir, f)
        const st = statSync(p)
        return { name: f, path: p, mtime: st.mtimeMs, size: st.size }
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

  // Impl-gate P2-6 (AC-6): total-size cap over the ROTATABLE set. count/days
  // alone let a large DB's scheduled set grow unbounded between prunes; once
  // the surviving rotatable backups exceed the cap, drop oldest-first (the
  // never-to-0 guard below still applies). Protected kinds are untouched.
  if (opts.maxTotalBytes !== undefined && opts.maxTotalBytes > 0) {
    const surviving = rotatable.filter((f) => !toDelete.includes(f)) // newest-first
    let total = surviving.reduce((s, f) => s + f.size, 0)
    for (let i = surviving.length - 1; i >= 1 && total > opts.maxTotalBytes; i--) {
      const victim = surviving[i]!
      toDelete.push(victim)
      total -= victim.size
    }
  }

  // RFC-311 (C4): protected families rotate too, each keeping its newest N.
  // Families are pruned independently (a burst of pre-migration backups must
  // not evict the manual set and vice versa).
  if (opts.protectedKeepCount !== undefined && opts.protectedKeepCount > 0) {
    const familyOf = (name: string): string | null => {
      if (isRotatable(name)) return null
      if (name.startsWith('agent-workflow-')) return 'manual'
      const preMatch = /^(pre-[a-z-]+?)-/.exec(name)
      return preMatch ? preMatch[1]! : 'other-protected'
    }
    const byFamily = new Map<string, typeof files>()
    for (const f of files) {
      const family = familyOf(f.name)
      if (family === null) continue
      const bucket = byFamily.get(family)
      if (bucket === undefined) byFamily.set(family, [f])
      else bucket.push(f)
    }
    for (const bucket of byFamily.values()) {
      bucket.sort((a, b) => b.mtime - a.mtime)
      for (const victim of bucket.slice(opts.protectedKeepCount)) toDelete.push(victim)
    }
  }

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
  /** Impl-gate P2-6 — see PruneOptions.maxTotalBytes (0 = off). */
  maxTotalBytes?: number
  appHome?: string
}

export interface BackupSchedulerHandle {
  stop: () => void
}

/** RFC-311 — one retention pass, shared by the backup tick and the
 *  standalone hourly loop. */
function runPrune(opts: BackupSchedulerOptions, appHome: string): void {
  pruneBackups({
    dir: join(appHome, 'backups'),
    count: opts.retentionCount,
    days: opts.retentionDays,
    maxTotalBytes: opts.maxTotalBytes,
    protectedKeepCount: opts.protectedKeepCount,
    now: Date.now(),
  })
}

/** Start the periodic backup ticker. intervalMs <= 0 disables the BACKUP tick
 *  only — RFC-311 (audit L3-2): retention used to be chained to it, so the
 *  default-off scheduler meant pruneBackups NEVER executed and backups/ grew
 *  without bound. Retention now runs at boot + hourly regardless. */
export function startBackupScheduler(opts: BackupSchedulerOptions): BackupSchedulerHandle {
  if (!opts.intervalMs || opts.intervalMs <= 0) {
    const appHome = opts.appHome ?? Paths.root
    try {
      runPrune(opts, appHome)
    } catch (err) {
      log.warn('boot prune threw', { error: (err as Error).message })
    }
    const pruneHandle = setInterval(() => {
      try {
        runPrune(opts, appHome)
      } catch (err) {
        log.warn('prune tick threw', { error: (err as Error).message })
      }
    }, 3_600_000)
    ;(pruneHandle as { unref?: () => void }).unref?.()
    return { stop: () => clearInterval(pruneHandle) }
  }
  const appHome = opts.appHome ?? Paths.root
  let running = false // reentrancy guard: a slow createBackup must not overlap
  const handle = setInterval(() => {
    if (running) return
    running = true
    ;(async () => {
      await createBackup({ db: opts.db, kind: 'scheduled', appHome })
      runPrune(opts, appHome)
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
