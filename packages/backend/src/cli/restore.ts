// `agent-workflow restore <tarball>` — RFC-213 PR-1a cold restore.
//
// Destructive + daemon-must-be-stopped. Without --yes it prints the plan and
// stops (so a fat-fingered restore can't overwrite data); --yes applies it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { planRestore, restoreBackup } from '@/services/restore'
import { isProcessAlive, readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface RestoreCommandResult {
  output: string
  status: 'ok' | 'error'
}

const USAGE =
  'usage: agent-workflow restore <tarball> [--yes] [--dry-run] ' +
  '[--no-safety-backup] [--no-migrate] [--skip-integrity-check]\n'

export async function restoreCommand(argv: string[]): Promise<RestoreCommandResult> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const tarball = argv.find((a) => !a.startsWith('--'))
  if (tarball === undefined) return { output: USAGE, status: 'error' }
  if (!existsSync(tarball)) {
    return { output: `restore failed: no such file: ${tarball}\n`, status: 'error' }
  }

  // Real single-instance check (NOT a flock): a stale/dead-pid lock — the exact
  // state after the crash that motivates a restore — must NOT block us.
  const pid = readPidFromLock(Paths.lock)
  if (pid !== null && isProcessAlive(pid)) {
    return {
      output:
        `restore refused: a daemon is running (pid ${pid}). ` +
        `Stop it first: agent-workflow stop\n`,
      status: 'error',
    }
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

    if (flags.has('--dry-run') || !flags.has('--yes')) {
      const hint = flags.has('--dry-run')
        ? '\n(dry-run — nothing changed)\n'
        : '\nre-run with --yes to APPLY (this OVERWRITES current data).\n'
      return { output: planLines.join('\n') + hint, status: 'ok' }
    }

    const res = await restoreBackup(tarball, {
      migrationsFolder,
      noSafetyBackup: flags.has('--no-safety-backup'),
      noMigrate: flags.has('--no-migrate'),
      skipIntegrityCheck: flags.has('--skip-integrity-check'),
    })
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
