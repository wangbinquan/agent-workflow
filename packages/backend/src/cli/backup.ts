// `agent-workflow backup` — produce a tarball of agent-workflow state.

import { createSecretBox } from '@/auth/secretBox'
import { openDb } from '@/db/client'
import { createBackup } from '@/services/backup'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { Paths } from '@/util/paths'

export interface BackupCommandResult {
  output: string
  status: 'ok' | 'error'
}

export async function backupCommand(argv: string[] = []): Promise<BackupCommandResult> {
  const includeWorktrees = argv.includes('--include-worktrees')
  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  try {
    // RFC-204: seal BEFORE `VACUUM INTO` copies the database. This command runs
    // migrations itself and never touches the daemon's startup path, so without
    // this the first backup after an upgrade would faithfully preserve every
    // legacy plaintext credential in the tarball.
    ensureCredentialsSealed(db, createSecretBox(Paths.secretKeyFile))
    const r = await createBackup({ db, includeWorktrees })
    const sizeMb = (r.sizeBytes / 1024 / 1024).toFixed(2)
    const lines = [
      `backup written: ${r.path}`,
      `  size:      ${sizeMb} MB`,
      `  workflows: ${r.contents.workflows}`,
      `  skills:    ${r.contents.skills} files`,
      `  db:        ${r.contents.db ? 'included' : 'missing'}`,
      `  config:    ${r.contents.config ? 'included' : 'missing'}`,
    ]
    return { output: lines.join('\n') + '\n', status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `backup failed: ${msg}\n`, status: 'error' }
  }
}
