// `agent-workflow restore <tarball>` — RFC-213 PR-1a cold restore.
//
// Destructive + daemon-must-be-stopped. Without --yes it prints the plan and
// stops (so a fat-fingered restore can't overwrite data); --yes applies it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { planRestore, restoreBackup, validateBackupForStage } from '@/services/restore'
import { stagePendingRestore } from '@/services/pendingRestore'
import { acquireLock, isProcessAlive, readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface RestoreCommandResult {
  output: string
  status: 'ok' | 'error'
}

const USAGE =
  'usage: agent-workflow restore <tarball> [--yes] [--stage] [--dry-run] ' +
  '[--no-safety-backup] [--no-migrate] [--skip-integrity-check]\n'

export async function restoreCommand(argv: string[]): Promise<RestoreCommandResult> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const tarball = argv.find((a) => !a.startsWith('--'))
  if (tarball === undefined) return { output: USAGE, status: 'error' }
  if (!existsSync(tarball)) {
    return { output: `restore failed: no such file: ${tarball}\n`, status: 'error' }
  }

  // Resolve the migrations folder (the version gate reads its _journal.json).
  let migrationsFolder = Paths.migrationsDir
  if (IS_EMBEDDED) {
    migrationsFolder = join(Paths.root, 'runtime', 'migrations')
    await extractMigrationsTo(migrationsFolder)
  }

  try {
    const plan = await planRestore(tarball, { migrationsFolder })
    const planLines = [
      `restore plan for ${tarball}:`,
      `  kind:      ${plan.manifest?.kind ?? 'unknown (legacy backup)'}`,
      `  direction: ${plan.direction}`,
      `  backup migration: ${plan.backupLastCreatedAt ?? 'unknown'}`,
      `  this binary:      ${plan.currentMaxWhen}`,
    ]
    if (plan.direction === 'downgrade') {
      return {
        output:
          planLines.join('\n') +
          '\nrefused: the backup is NEWER than this binary; cannot downgrade.\n',
        status: 'error',
      }
    }

    const applyOpts = {
      noSafetyBackup: flags.has('--no-safety-backup'),
      noMigrate: flags.has('--no-migrate'),
      skipIntegrityCheck: flags.has('--skip-integrity-check'),
    }

    // Read-only outcomes first (impl-gate P2-15: a dry-run / plan print must not
    // be refused just because the daemon is up — nothing is changed).
    if (flags.has('--dry-run') || (!flags.has('--yes') && !flags.has('--stage'))) {
      const hint = flags.has('--dry-run')
        ? '\n(dry-run — nothing changed)\n'
        : '\nre-run with --yes to APPLY (this OVERWRITES current data).\n'
      return { output: planLines.join('\n') + hint, status: 'ok' }
    }

    // --stage: write a pending marker to apply on the NEXT daemon boot (the swap
    // then runs while the DB is closed). Safe to run WHILE the daemon is up.
    // Impl-gate P1-1: validate the tarball to the SAME depth the boot apply will
    // enforce (db.sqlite present + quick_check unless the escape hatch rides
    // along) — staging an invalid package used to arm a boot-loop brick.
    if (flags.has('--stage')) {
      await validateBackupForStage(tarball, {
        migrationsFolder,
        skipIntegrityCheck: applyOpts.skipIntegrityCheck,
      })
      stagePendingRestore(tarball, { ...applyOpts, now: Date.now() })
      return {
        output:
          planLines.join('\n') +
          '\nSTAGED — restart the daemon to apply (agent-workflow stop && agent-workflow start).\n',
        status: 'ok',
      }
    }

    // Cold restore requires the daemon STOPPED. A stale/dead-pid lock (the exact
    // state after the crash that motivates a restore) must NOT block us — but a
    // LIVE daemon must (impl-gate P2-10: the old one-shot pid probe left a TOCTOU
    // window where a daemon started mid-restore and kept writing the old inode;
    // holding the daemon's own flock for the whole swap closes it).
    const pid = readPidFromLock(Paths.lock)
    if (pid !== null && isProcessAlive(pid)) {
      return {
        output:
          `restore refused: a daemon is running (pid ${pid}). ` +
          `Stop it first (or use --stage to apply on next boot): agent-workflow stop\n`,
        status: 'error',
      }
    }
    let lock: ReturnType<typeof acquireLock>
    try {
      lock = acquireLock(Paths.lock)
    } catch {
      return {
        output:
          'restore refused: could not take the daemon lock (a daemon is starting?). ' +
          'Stop it first, or use --stage to apply on next boot.\n',
        status: 'error',
      }
    }
    let res: Awaited<ReturnType<typeof restoreBackup>>
    try {
      res = await restoreBackup(tarball, { migrationsFolder, ...applyOpts })
    } finally {
      lock.release()
    }
    const lines = [
      'restore complete:',
      `  direction:     ${res.direction}`,
      `  migrated:      ${res.migrated}`,
      `  safety backup: ${res.safetyBackupPath ?? 'skipped'}`,
      `  restored:      db=${res.restored.db} config=${res.restored.config} skills=${res.restored.skills}`,
    ]
    return { output: lines.join('\n') + '\n', status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `restore failed: ${msg}\n`, status: 'error' }
  }
}
