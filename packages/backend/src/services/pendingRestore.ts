// RFC-213 PR-1b — staged ("hot") restore.
//
// A cold `restore` needs the daemon stopped. When it's running (or for a
// UI-triggered restore), stage the tarball instead: write a marker + a copy of
// the tarball under `.restore-pending/`, and apply it on the NEXT boot — AFTER
// acquireLock, BEFORE openDb (design.md §4.2), so the swap happens while the DB
// is closed. Idempotent: a marker whose staged tarball is already gone means a
// prior boot consumed it → clear + continue (never fail-closed on it, or a
// half-consumed restore would brick every boot).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DomainError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { restoreBackup, RestorePostSwapError } from './restore'
import type { SqlitePostRestoreRecovery } from '@/platform/persistence/sqlite/systemProviderRestore'

const log = createLogger('pendingRestore')

/**
 * RFC-359 W8 —— 标记的**类型**校验（对齐 PostgreSQL 侧的 `postgresqlPendingRestore.ts`）。
 *
 * 此前这里只做 `JSON.parse`，于是一个结构合法、字段类型错乱的标记
 * （截断 / 半写 / 手改坏）会被原样投影出去：`requestedAt: "yesterday"` 直接流进
 * `recoveryStatusViewSchema`，把 `GET /api/restore/pending` 炸成 500——而取消按钮就在
 * 同一个面板上，用户此刻恰恰最需要它可用。PostgreSQL 侧用 zod 校验后返回 null，
 * 面板照常渲染成「没有待还原」，两侧对拍照出了这一条
 * （`tests/rfc359-w8-system-operations-recovery-conformance.test.ts` ⑤）。
 *
 * 只校验**投影与 boot 应用真正消费的字段**，不拒绝未知键：SQLite 的标记没有 PG 那个
 * 显式 `version` 字段，严格模式会让「新版本写的标记被旧二进制读到」变成静默丢弃一次
 * 已排队的还原——那比多容忍几个键危险得多。
 */
const pendingRestoreMarkerSchema = z.object({
  stagedTarball: z.string().min(1),
  noSafetyBackup: z.boolean().optional(),
  noMigrate: z.boolean().optional(),
  skipIntegrityCheck: z.boolean().optional(),
  requestedAt: z.number(),
})

type PendingRestoreMarker = z.infer<typeof pendingRestoreMarkerSchema>

const pendingDir = (appHome: string): string => join(appHome, '.restore-pending')
const markerPath = (appHome: string): string => join(pendingDir(appHome), 'restore-pending.json')
const stagedPath = (appHome: string): string => join(pendingDir(appHome), 'staged.tar.gz')

/** 读并校验标记；读不到 / 读不懂一律 null（调用方据此当成「没有待还原」）。 */
function parsePendingRestoreMarker(appHome: string): PendingRestoreMarker | null {
  const path = markerPath(appHome)
  if (!existsSync(path)) return null
  try {
    return pendingRestoreMarkerSchema.parse(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}

export function hasPendingRestore(appHome: string = Paths.root): boolean {
  return existsSync(markerPath(appHome))
}

/** Impl-gate P1-5 — the staged restore must be VISIBLE and CANCELABLE. */
export interface PendingRestoreInfo {
  requestedAt: number
  stagedBytes: number | null
  noMigrate: boolean
  skipIntegrityCheck: boolean
}

export function readPendingRestore(appHome: string = Paths.root): PendingRestoreInfo | null {
  const marker = parsePendingRestoreMarker(appHome)
  if (marker === null) return null
  let stagedBytes: number | null = null
  try {
    stagedBytes = statSync(marker.stagedTarball).size
  } catch {
    stagedBytes = null
  }
  return {
    requestedAt: marker.requestedAt,
    stagedBytes,
    noMigrate: marker.noMigrate === true,
    skipIntegrityCheck: marker.skipIntegrityCheck === true,
  }
}

/** Cancel (dis-arm) a staged restore. Returns true iff one was pending. */
export function clearPendingRestore(appHome: string = Paths.root): boolean {
  const dir = pendingDir(appHome)
  if (!existsSync(markerPath(appHome))) return false
  rmSync(dir, { recursive: true, force: true })
  log.info('pending restore cleared (canceled)')
  return true
}

/** Failed staged-restore quarantine dirs (`.restore-pending.failed-<ts>`). */
export interface FailedRestoreInfo {
  dir: string
  failedAt: number | null
  error: string | null
}

export function listFailedRestores(appHome: string = Paths.root): FailedRestoreInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(appHome)
  } catch {
    return []
  }
  const out: FailedRestoreInfo[] = []
  for (const name of entries) {
    if (!name.startsWith('.restore-pending.failed-')) continue
    const dir = join(appHome, name)
    const ts = Number(name.slice('.restore-pending.failed-'.length))
    let error: string | null = null
    try {
      error = readFileSync(join(dir, 'error.txt'), 'utf-8').trim()
    } catch {
      error = null
    }
    out.push({ dir, failedAt: Number.isFinite(ts) ? ts : null, error })
  }
  return out.sort((a, b) => (b.failedAt ?? 0) - (a.failedAt ?? 0))
}

export interface StagePendingRestoreOptions {
  appHome?: string
  noSafetyBackup?: boolean
  noMigrate?: boolean
  skipIntegrityCheck?: boolean
  now: number
}

/** Stage an (already-validated) tarball to be restored on the next daemon boot. */
export function stagePendingRestore(tarballPath: string, opts: StagePendingRestoreOptions): void {
  const appHome = opts.appHome ?? Paths.root
  const dir = pendingDir(appHome)
  // Impl-gate P0-3 (Codex 2026-07-22): the old unconditional rm+recreate raced two
  // concurrent stagers (CLI + API) into a spliced state — B's tarball left under
  // A's marker/options. Use a NON-recursive mkdir as an atomic O_EXCL lock: the
  // second stager gets EEXIST → 409. Replacing an existing staged restore requires
  // an explicit cancel first (DELETE /api/restore/pending).
  mkdirSync(appHome, { recursive: true })
  try {
    mkdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DomainError(
        'restore-already-pending',
        'a restore is already staged; cancel it (DELETE /api/restore/pending) before staging another',
        409,
        undefined,
      )
    }
    throw err
  }
  // RFC-359 W8 —— 暂存中途失败必须把刚建的目录收回去（对齐 PostgreSQL 侧）。
  //
  // 上面那个 O_EXCL mkdir 是「已经排了一个还原」的**唯一**判据，而 `readPendingRestore` /
  // `clearPendingRestore` 认的是**标记文件**。两者一旦不同步——拷贝或写标记在中途失败，
  // 目录留下、标记没写成——实例就永久卡死：面板说「没有待还原」、取消说「没清掉任何东西」、
  // 而每一次重新上传还原包都被 409「已经排了一个还原，请先取消」挡回去，三条互相矛盾，
  // 且没有任何一条提到该去删 `~/.agent-workflow/.restore-pending`。灾难恢复当场归零。
  // PostgreSQL 侧一直是收回去的；两侧对拍照出了这一条
  // （`tests/rfc359-w8-system-operations-recovery-conformance.test.ts` ④）。
  try {
    cpSync(tarballPath, stagedPath(appHome))
    const marker: PendingRestoreMarker = {
      stagedTarball: stagedPath(appHome),
      noSafetyBackup: opts.noSafetyBackup,
      noMigrate: opts.noMigrate,
      skipIntegrityCheck: opts.skipIntegrityCheck,
      requestedAt: opts.now,
    }
    writeFileSync(markerPath(appHome), JSON.stringify(marker), 'utf-8')
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  log.info('staged pending restore', { staged: stagedPath(appHome) })
}

export interface ApplyPendingRestoreOptions {
  appHome?: string
  dbPath?: string
  migrationsFolder: string
  postOpenRecovery: SqlitePostRestoreRecovery
  now?: number
  /** Test-only: forwarded to restoreBackup's post-swap fault seam so a test can
   *  exercise the fail-closed rethrow path (P0-1). Never set in production. */
  __afterSwapForTest?: () => void | Promise<void>
}

/**
 * Apply a staged restore if one is pending. MUST run after acquireLock and
 * before openDb so exactly one process consumes it and the swap runs on a closed
 * DB. Returns true iff a restore was applied.
 */
export async function applyPendingRestoreIfAny(opts: ApplyPendingRestoreOptions): Promise<boolean> {
  const appHome = opts.appHome ?? Paths.root
  if (!existsSync(markerPath(appHome))) return false

  // 与 `readPendingRestore` 共用同一个校验器：boot 应用路径与状态面板对「这个标记算不算数」
  // 必须给同一个答案，否则面板说没有、boot 却拿一个字段类型错乱的标记去跑还原。
  const marker = parsePendingRestoreMarker(appHome)
  if (marker === null) {
    log.warn('pending-restore marker unreadable — clearing')
    rmSync(pendingDir(appHome), { recursive: true, force: true })
    return false
  }

  // Idempotency: a marker whose tarball is gone was already applied on a prior
  // boot (we delete the tarball before clearing the marker). Clear + continue.
  if (!existsSync(marker.stagedTarball)) {
    log.warn('pending-restore already consumed (tarball gone) — clearing marker')
    rmSync(pendingDir(appHome), { recursive: true, force: true })
    return false
  }

  log.warn('applying staged restore before openDb', { staged: marker.stagedTarball })
  try {
    await restoreBackup(marker.stagedTarball, {
      appHome,
      dbPath: opts.dbPath,
      migrationsFolder: opts.migrationsFolder,
      noSafetyBackup: marker.noSafetyBackup,
      noMigrate: marker.noMigrate,
      skipIntegrityCheck: marker.skipIntegrityCheck,
      postOpenRecovery: opts.postOpenRecovery,
      now: opts.now,
      __afterSwapForTest: opts.__afterSwapForTest,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Quarantine the staged dir for BOTH failure classes so the NEXT boot never
    // re-runs the same failing apply (P1-1 anti-brick) and it stays visible via
    // listFailedRestores / GET /api/restore/pending.
    const quarantine = `${pendingDir(appHome)}.failed-${opts.now ?? Date.now()}`
    try {
      renameSync(pendingDir(appHome), quarantine)
      writeFileSync(join(quarantine, 'error.txt'), `${message}\n`, 'utf-8')
    } catch {
      // rename failed (exotic fs state) — fall back to clearing so we still boot.
      rmSync(pendingDir(appHome), { recursive: true, force: true })
    }
    // Impl-gate P0-1 (Codex 2026-07-22): a POST-SWAP failure means the live DB is
    // ALREADY the restored generation, so config/skills/migrations may be
    // half-applied and non-terminal tasks are not suspended. Quarantine (above,
    // so the next boot doesn't loop) but then FAIL CLOSED — rethrow so start.ts
    // refuses to boot this mixed state and points the operator at the pre-restore
    // safety backup. A PRE-swap refusal instead leaves the live DB untouched, so
    // returning false to boot the still-healthy DB is sound (the P1-1 path).
    if (err instanceof RestorePostSwapError) {
      log.error('staged restore FAILED AFTER db swap — quarantined + failing closed', {
        error: message,
        quarantine,
      })
      throw err
    }
    log.error('staged restore FAILED (pre-swap) — quarantined, booting WITHOUT applying it', {
      error: message,
      quarantine,
    })
    return false
  }

  // Delete the staged tarball FIRST (the idempotency signal), then the marker as
  // the final step. A crash in between → next boot sees "tarball gone" → clears.
  try {
    rmSync(marker.stagedTarball, { force: true })
  } catch {
    /* best-effort */
  }
  rmSync(pendingDir(appHome), { recursive: true, force: true })
  return true
}
