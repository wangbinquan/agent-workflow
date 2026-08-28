// RFC-213 PR-3 — scheduled backup + retention + pre-migration safety net.
//
// - startBackupScheduler: an interval ticker (reentrancy-guarded, like the GC /
//   orphan-reconcile loops) that fires createBackup + prunes old ones.
// - pruneBackups: KEEP a scheduled/auto backup iff it is within the newest N OR
//   newer than D days; DELETE only when it fails BOTH. Manual + pre-restore +
//   pre-migration backups rotate per family under `protectedKeepCount`
//   (RFC-311 C4;0/未配置 = 历史的「永不自动清理」)。Never deletes the last backup.
// - maybePreMigrationBackup: before boot migrations, raw-copy the DB so a botched
//   upgrade can be rolled back (rawCopyDb, NOT createBackup — the OLD schema
//   can't be SELECTed by the NEW binary).

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { createBackup, isDbSnapshotInProgress } from '@/services/backup'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { readDbMigrationIdentity, readMigrationAxisFromJournal } from './backupManifest'
import { HOUR_MS, MAINTENANCE_PHASE } from './daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'
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
      // 实现门 P1-5:`pre-restore-*`(DB 安全副本)与 `pre-restore-fs-*`(文件系统
      // 包)是**配对**制品,非贪婪前缀会把它们归进同一个家族,修剪时可能拆散配对
      // ——恢复要两半齐全才有意义。取到第二个连字符前的完整族名。
      const preMatch = /^(pre-[a-z]+(?:-fs)?)-/.exec(name)
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
  /** RFC-311 (C4) — see PruneOptions.protectedKeepCount. */
  protectedKeepCount?: number
  /** RFC-311 实现门 P1-5:保留旋钮**每拍热读**,而不是 boot 时捕获一次。C4 承诺
   *  的缓解是「上限可配」,但捕获式装配意味着改完必须重启 daemon 才生效——同批的
   *  归档器/保留 sweeper 都是传 getter 热读,这里不该是另一种约定。返回 undefined
   *  表示沿用构造时的值。 */
  loadRetention?: () => {
    retentionCount?: number
    retentionDays?: number
    maxTotalBytes?: number
    protectedKeepCount?: number
  }
  appHome?: string
  /** RFC-338: production delegates retention to the maintenance Worker. The
   * default stays internal for embedded callers and existing unit tests. */
  pruneMode?: 'internal' | 'external'
  /** Wake the external prune owner after a scheduled backup settles. */
  onBackupSettled?: () => void
}

export interface BackupSchedulerHandle {
  stop: () => void
}

/** RFC-311 — one retention pass, shared by the backup tick and the
 *  standalone hourly loop. */
function runPrune(opts: BackupSchedulerOptions, appHome: string): void {
  const live = opts.loadRetention?.() ?? {}
  pruneBackups({
    dir: join(appHome, 'backups'),
    count: live.retentionCount ?? opts.retentionCount,
    days: live.retentionDays ?? opts.retentionDays,
    maxTotalBytes: live.maxTotalBytes ?? opts.maxTotalBytes,
    protectedKeepCount: live.protectedKeepCount ?? opts.protectedKeepCount,
    now: Date.now(),
  })
}

/** Start the periodic backup ticker. intervalMs <= 0 disables the BACKUP tick
 *  only — RFC-311 (audit L3-2): retention used to be chained to it, so the
 *  default-off scheduler meant pruneBackups NEVER executed and backups/ grew
 *  without bound. Retention now runs at boot + hourly regardless. */
export function startBackupScheduler(opts: BackupSchedulerOptions): BackupSchedulerHandle {
  const appHome = opts.appHome ?? Paths.root
  const externalPrune = opts.pruneMode === 'external'
  const safePrune = (label: string): void => {
    try {
      runPrune(opts, appHome)
    } catch (err) {
      log.warn(`${label} threw`, { error: (err as Error).message })
    }
  }
  // Retention runs at boot + hourly **unconditionally**. The first cut of this
  // still chained it to the backup tick when one was configured, so a machine
  // whose `createBackup` kept failing (no `tar`, disk full) never pruned at all
  // — the very L3-2 shape C4 exists to fix, just with a narrower trigger.
  // Implementation-gate finding P2-1 / mutation #19.
  if (!externalPrune) safePrune('boot prune')
  // RFC-322：这里原本是 `setInterval(…, 3_600_000)` 裸字面量——正是 daemonCadence
  // 头部注释点名的那种形状，现收编进相位注册表。
  const pruneTicker = externalPrune
    ? { stop: (): void => {} }
    : startMaintenanceTicker({
        job: 'backupPrune',
        intervalMs: HOUR_MS,
        phaseOffsetMs: MAINTENANCE_PHASE.backupPrune,
        onTick: () => safePrune('prune tick'),
      })

  if (!opts.intervalMs || opts.intervalMs <= 0) {
    return { stop: () => pruneTicker.stop() }
  }
  let running = false // reentrancy guard: a slow createBackup must not overlap
  const handle = setInterval(() => {
    if (running) return
    running = true
    ;(async () => {
      await createBackup({ db: opts.db, kind: 'scheduled', appHome })
    })()
      .catch((err) => log.warn('backup tick threw', { error: (err as Error).message }))
      .finally(() => {
        // A fresh backup is exactly when the family caps want re-applying, and
        // it must survive a failed backup — hence `finally`, not the then-path.
        if (externalPrune) {
          try {
            opts.onBackupSettled?.()
          } catch (err) {
            log.warn('external post-backup prune wake threw', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        } else {
          safePrune('post-backup prune')
        }
        running = false
      })
  }, opts.intervalMs)
  ;(handle as { unref?: () => void }).unref?.()
  return {
    stop: () => {
      clearInterval(handle)
      pruneTicker.stop()
    },
  }
}

/** RFC-213 G4c — one `wal_checkpoint(TRUNCATE)` on the live DB. Exported so the
 *  truncation behaviour is unit-tested directly (the ticker is just a timer). */
export function checkpointWal(db: DbClient): void {
  const sqlite = (db as unknown as { $client: { exec: (s: string) => void } }).$client
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
}

/** One checkpoint tick. Returns what it did so the behaviour is testable
 *  without waiting on a timer.
 *
 *  实现门 P0-2:备份持有的只读快照会让 `wal_checkpoint(TRUNCATE)` 阻塞满
 *  `busy_timeout`(5 秒,实测 5310ms),而它跑在 daemon 的同步主连接上 ⇒ 全站冻结
 *  5 秒。快照期间直接跳过这一拍:WAL 多长 10 分钟无害,冻结 5 秒不可接受。 */
export function runWalCheckpointTick(db: DbClient): 'checkpointed' | 'skipped-snapshot' {
  if (isDbSnapshotInProgress()) return 'skipped-snapshot'
  checkpointWal(db)
  return 'checkpointed'
}

export interface WalCheckpointOptions {
  db: DbClient
  /**
   * RFC-311 余项（2026-08-21）：**每拍热读**，与 events 归档器 / webhook GC /
   * worktree GC 同款约定。此前这里收的是 `intervalMs: number`，而 `cli/start.ts`
   * 传的是 boot 配置快照——把 `walCheckpointIntervalMs` 从 0 改成 600000 之后不
   * 重启 daemon 永远不生效，而且 0 的那次启动直接 `return` 空 handle，进程里连
   * timer 都不存在，没有任何东西会去重读配置（用户实测：改完文件、-wal 照涨）。
   * 返回 0 = 关（但监督拍还在，改回非 0 立刻恢复）。
   */
  getIntervalMs: () => number
  /**
   * 监督拍：多久**看一眼配置**（默认 60s）。它与「多久 checkpoint 一次」是两件
   * 事——配置值会被向上取整到监督拍的粒度，所以小于 tickMs 的配置值没有意义。
   */
  tickMs?: number
  /** 注入时钟（测试用）。 */
  now?: () => number
}

/** Periodically checkpoint(TRUNCATE) the WAL to bound -wal growth. 0 = off. */
export function startWalCheckpointLoop(opts: WalCheckpointOptions): BackupSchedulerHandle {
  const tickMs = opts.tickMs ?? 60_000
  const now = opts.now ?? Date.now
  let lastCheckpointAt = now()
  // 整拍是同步的（checkpointWal 走 exec），所以不需要重入守卫。
  const handle = setInterval(() => {
    // try 把 `getIntervalMs()` 也罩进来:热读意味着每拍都要碰一次 config 文件,
    // 而定时器回调里抛出的同步异常没人接得住(会变成 uncaughtException 打死
    // daemon)——一个坏掉的 config.json 不该因为 checkpoint 循环而升级成宕机。
    try {
      const intervalMs = opts.getIntervalMs()
      if (intervalMs <= 0) return
      if (now() - lastCheckpointAt < intervalMs) return
      // 快照期间的跳拍**不推进**水位:下一个监督拍(而不是下一个整间隔)就重试,
      // 备份一结束 -wal 立刻被收掉。失败则推进——`wal_checkpoint(TRUNCATE)` 撞上
      // 活跃 reader 会阻塞满 busy_timeout(5s)并冻结全站(实现门 P0-2),每 60s
      // 重试一次等于把那 5 秒冻结变成常态,宁可等满一个间隔。
      if (runWalCheckpointTick(opts.db) === 'checkpointed') lastCheckpointAt = now()
    } catch (err) {
      log.warn('wal checkpoint failed', { error: (err as Error).message })
      lastCheckpointAt = now()
    }
  }, tickMs)
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
