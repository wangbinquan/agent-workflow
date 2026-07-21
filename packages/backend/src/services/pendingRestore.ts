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
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { restoreBackup } from './restore'

const log = createLogger('pendingRestore')

interface PendingRestoreMarker {
  stagedTarball: string
  noSafetyBackup?: boolean
  noMigrate?: boolean
  skipIntegrityCheck?: boolean
  requestedAt: number
}

const pendingDir = (appHome: string): string => join(appHome, '.restore-pending')
const markerPath = (appHome: string): string => join(pendingDir(appHome), 'restore-pending.json')
const stagedPath = (appHome: string): string => join(pendingDir(appHome), 'staged.tar.gz')

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
  const mPath = markerPath(appHome)
  if (!existsSync(mPath)) return null
  try {
    const marker = JSON.parse(readFileSync(mPath, 'utf-8')) as PendingRestoreMarker
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
  } catch {
    return null
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
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(tarballPath, stagedPath(appHome))
  const marker: PendingRestoreMarker = {
    stagedTarball: stagedPath(appHome),
    noSafetyBackup: opts.noSafetyBackup,
    noMigrate: opts.noMigrate,
    skipIntegrityCheck: opts.skipIntegrityCheck,
    requestedAt: opts.now,
  }
  writeFileSync(markerPath(appHome), JSON.stringify(marker), 'utf-8')
  log.info('staged pending restore', { staged: stagedPath(appHome) })
}

export interface ApplyPendingRestoreOptions {
  appHome?: string
  dbPath?: string
  migrationsFolder: string
  now?: number
}

/**
 * Apply a staged restore if one is pending. MUST run after acquireLock and
 * before openDb so exactly one process consumes it and the swap runs on a closed
 * DB. Returns true iff a restore was applied.
 */
export async function applyPendingRestoreIfAny(opts: ApplyPendingRestoreOptions): Promise<boolean> {
  const appHome = opts.appHome ?? Paths.root
  const mPath = markerPath(appHome)
  if (!existsSync(mPath)) return false

  let marker: PendingRestoreMarker
  try {
    marker = JSON.parse(readFileSync(mPath, 'utf-8')) as PendingRestoreMarker
  } catch {
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
      now: opts.now,
    })
  } catch (err) {
    // Impl-gate P1-1 (2026-07-22): a failed staged apply must NEVER brick the
    // boot loop. The marker + tarball survive a throw, so exiting here made
    // every subsequent startup re-fail identically (deterministic inputs) with
    // no in-product escape. `restoreBackup` throws BEFORE touching the live DB
    // for every refusal class (validation, safety-backup failure), and its swap
    // sequence is crash-safe — so "give up on the staged restore, boot the
    // still-healthy DB" is sound. Quarantine the staged dir for forensics and
    // surface it via listFailedRestores / GET /api/restore/pending.
    const message = err instanceof Error ? err.message : String(err)
    const quarantine = `${pendingDir(appHome)}.failed-${opts.now ?? Date.now()}`
    try {
      renameSync(pendingDir(appHome), quarantine)
      writeFileSync(join(quarantine, 'error.txt'), `${message}\n`, 'utf-8')
    } catch {
      // rename failed (exotic fs state) — fall back to clearing so we still boot.
      rmSync(pendingDir(appHome), { recursive: true, force: true })
    }
    log.error('staged restore FAILED — quarantined, booting WITHOUT applying it', {
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
