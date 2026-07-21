// RFC-213 PR-1b — staged ("hot") restore.
//
// A cold `restore` needs the daemon stopped. When it's running (or for a
// UI-triggered restore), stage the tarball instead: write a marker + a copy of
// the tarball under `.restore-pending/`, and apply it on the NEXT boot — AFTER
// acquireLock, BEFORE openDb (design.md §4.2), so the swap happens while the DB
// is closed. Idempotent: a marker whose staged tarball is already gone means a
// prior boot consumed it → clear + continue (never fail-closed on it, or a
// half-consumed restore would brick every boot).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // Idempotency: a marker whose tarball is gone was already applied on a prior
  // boot (we delete the tarball before clearing the marker). Clear + continue.
  if (!existsSync(marker.stagedTarball)) {
    log.warn('pending-restore already consumed (tarball gone) — clearing marker')
    rmSync(pendingDir(appHome), { recursive: true, force: true })
    return false
  }

  log.warn('applying staged restore before openDb', { staged: marker.stagedTarball })
  await restoreBackup(marker.stagedTarball, {
    appHome,
    dbPath: opts.dbPath,
    migrationsFolder: opts.migrationsFolder,
    noSafetyBackup: marker.noSafetyBackup,
    noMigrate: marker.noMigrate,
    skipIntegrityCheck: marker.skipIntegrityCheck,
    now: opts.now,
  })

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
