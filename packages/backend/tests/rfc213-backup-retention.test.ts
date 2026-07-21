// RFC-213 PR-3 — scheduled-backup retention + scheduler side-effects.
//
// design/RFC-213-disaster-recovery/design.md §6.2 / §7 #7:
//   - KEEP a scheduled/auto backup iff within newest N OR newer than D days;
//     DELETE only when it fails BOTH. Manual + pre-* are never auto-pruned.
//   - intervalMs=0 → the scheduler produces NOTHING (no timer, no files).
//
// MUTATION CHECKS (manually verified):
//   - change the retention `!withinCount && !withinDays` to `||` → the
//     days-window scenario deletes backups it should keep → red.
//   - remove the `running` reentrancy guard → the source lock test reds.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pruneBackups, startBackupScheduler } from '../src/services/backupScheduler'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-ret-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DAY = 86_400_000
const NOW = 1_000_000_000_000

/** Create an empty backup file with a controlled mtime (ms since epoch). */
function mkBackup(dir: string, name: string, mtimeMs: number, bytes = 1): void {
  const p = join(dir, name)
  writeFileSync(p, 'x'.repeat(bytes))
  const secs = mtimeMs / 1000
  utimesSync(p, secs, secs)
}

function names(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort()
}

describe('pruneBackups retention policy (AC-6)', () => {
  test('count-based: with all backups old, keep the newest N scheduled ones', () => {
    const dir = tmp()
    for (let i = 0; i < 6; i++) mkBackup(dir, `scheduled-${i}.tar.gz`, NOW - (i + 10) * DAY)
    // days=1 so the day-window keeps nothing (all are 10+ days old) → count decides.
    pruneBackups({ dir, count: 3, days: 1, now: NOW })
    expect(names(dir)).toEqual(['scheduled-0.tar.gz', 'scheduled-1.tar.gz', 'scheduled-2.tar.gz'])
  })

  test('days-based: recent backups survive even beyond the count', () => {
    const dir = tmp()
    // 6 scheduled, ALL within the last 5 days.
    for (let i = 0; i < 6; i++) mkBackup(dir, `scheduled-${i}.tar.gz`, NOW - i * (DAY / 2))
    pruneBackups({ dir, count: 1, days: 30, now: NOW })
    // count=1 would keep only the newest, but days=30 keeps all 6.
    expect(names(dir).length).toBe(6)
  })

  test('manual + pre-restore + pre-migration backups are never auto-pruned', () => {
    const dir = tmp()
    mkBackup(dir, 'agent-workflow-1.tar.gz', NOW - 100 * DAY) // manual, ancient
    mkBackup(dir, 'pre-restore-1.tar.gz', NOW - 100 * DAY)
    mkBackup(dir, 'pre-migration-1.tar.gz', NOW - 100 * DAY)
    for (let i = 0; i < 4; i++) mkBackup(dir, `scheduled-${i}.tar.gz`, NOW - (i + 10) * DAY)
    pruneBackups({ dir, count: 1, days: 1, now: NOW })
    // Only scheduled rotate (keep newest 1); the 3 protected ones all survive.
    expect(names(dir)).toEqual([
      'agent-workflow-1.tar.gz',
      'pre-migration-1.tar.gz',
      'pre-restore-1.tar.gz',
      'scheduled-0.tar.gz',
    ])
  })

  test('never deletes the last backup on disk', () => {
    const dir = tmp()
    // A single ancient scheduled backup: count>=1 keeps the newest (idx 0) anyway,
    // and the never-to-0 belt also protects it.
    mkBackup(dir, 'scheduled-0.tar.gz', NOW - 999 * DAY)
    pruneBackups({ dir, count: 1, days: 1, now: NOW })
    expect(names(dir)).toEqual(['scheduled-0.tar.gz'])
  })
})

describe('impl-gate P2-6 — total-size cap over the rotatable set (AC-6)', () => {
  test('oldest rotatable backups fall to the cap; protected + newest survive', () => {
    const dir = tmp()
    // 4 scheduled × 100B (newest→oldest) + 1 protected × 1000B; all recent (days
    // keep them, count keeps them) — ONLY the cap can prune. Cap 250B ⇒ newest
    // two scheduled fit (200B), older two go. Protected is not even counted.
    mkBackup(dir, 'scheduled-1.tar.gz', NOW - 1 * DAY, 100)
    mkBackup(dir, 'scheduled-2.tar.gz', NOW - 2 * DAY, 100)
    mkBackup(dir, 'scheduled-3.tar.gz', NOW - 3 * DAY, 100)
    mkBackup(dir, 'scheduled-4.tar.gz', NOW - 4 * DAY, 100)
    mkBackup(dir, 'manual-keep.tar.gz', NOW - 30 * DAY, 1000)
    const res = pruneBackups({ dir, count: 10, days: 30, now: NOW, maxTotalBytes: 250 })
    expect(res.deleted.sort()).toEqual(['scheduled-3.tar.gz', 'scheduled-4.tar.gz'])
    expect(names(dir)).toEqual(['manual-keep.tar.gz', 'scheduled-1.tar.gz', 'scheduled-2.tar.gz'])
  })

  test('cap never deletes down to zero rotatable backups', () => {
    const dir = tmp()
    mkBackup(dir, 'scheduled-only.tar.gz', NOW - 1 * DAY, 500)
    const res = pruneBackups({ dir, count: 10, days: 30, now: NOW, maxTotalBytes: 100 })
    expect(res.deleted).toEqual([])
    expect(names(dir)).toEqual(['scheduled-only.tar.gz'])
  })

  test('cap 0 / undefined = off (existing behaviour untouched)', () => {
    const dir = tmp()
    mkBackup(dir, 'scheduled-1.tar.gz', NOW - 1 * DAY, 1000)
    mkBackup(dir, 'scheduled-2.tar.gz', NOW - 2 * DAY, 1000)
    const res = pruneBackups({ dir, count: 10, days: 30, now: NOW, maxTotalBytes: 0 })
    expect(res.deleted).toEqual([])
  })
})

describe('startBackupScheduler side-effects (AC-6)', () => {
  test('intervalMs=0 creates no timer and no backups', async () => {
    const dir = tmp()
    const handle = startBackupScheduler({
      db: {} as never, // never used — the ticker never fires
      intervalMs: 0,
      retentionCount: 7,
      retentionDays: 30,
      appHome: dir,
    })
    // Give any (erroneously-scheduled) tick a chance to fire.
    await new Promise((r) => setTimeout(r, 60))
    let backups: string[] = []
    try {
      backups = readdirSync(join(dir, 'backups'))
    } catch {
      /* backups dir never created — good */
    }
    expect(backups.filter((f) => f.endsWith('.tar.gz'))).toEqual([])
    expect(() => handle.stop()).not.toThrow()
  })

  test('the scheduler ticker carries a reentrancy guard (source lock)', () => {
    // A slow createBackup must not overlap itself. Behavioural timing is flaky, so
    // lock the invariant at the source (same class as the sibling tickers).
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'backupScheduler.ts'),
      'utf-8',
    )
    expect(src.includes('let running = false')).toBe(true)
    expect(src.includes('if (running) return')).toBe(true)
  })
})
