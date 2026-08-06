// `agent-workflow migrate` — manually apply pending DB migrations.
// The daemon's `start` command already does this on boot; this subcommand
// exists as a recovery / debug fallback when the daemon won't start due to
// a failed migration that needs inspection.

import { openDb } from '@/db/client'
import { Paths } from '@/util/paths'

export function migrateCommand(): { output: string } {
  // openDb() applies all pending migrations. Close the handle before returning:
  // the production CLI exits right after (so a leak is harmless there), but the
  // in-process test harness reuses the process, and on Windows a leaked bun:sqlite
  // handle keeps db.sqlite (+ WAL -wal/-shm) OPEN, which locks the containing
  // directory — the caller's `rm(tempDir)` then fails EBUSY (POSIX lets you
  // unlink an open file; Windows does not). RFC-254 T31 (cli.test.ts teardown).
  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  db.$client.close()
  return { output: `migrations applied (database: ${Paths.db})\n` }
}
