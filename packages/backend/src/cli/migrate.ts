// `agent-workflow migrate` — manually apply pending DB migrations.
// The daemon's `start` command already does this on boot; this subcommand
// exists as a recovery / debug fallback when the daemon won't start due to
// a failed migration that needs inspection.

import { openDb } from '@/db/client'
import { Paths } from '@/util/paths'

export function migrateCommand(): { output: string } {
  // openDb() applies all pending migrations.
  // We don't return the DB handle — the process exits right after.
  openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  return { output: `migrations applied (database: ${Paths.db})\n` }
}
