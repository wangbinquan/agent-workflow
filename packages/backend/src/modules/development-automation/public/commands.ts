// Public maintenance commands owned by the development-automation context.
// Platform schedulers call this exact entrypoint instead of reaching through
// the module boundary to SQLite adapters.

import type { DbClient } from '@/db/client'
import { createSqliteAdmissionLookup } from '../infrastructure/sqliteAdmissionLookup'
import {
  sweepDevelopmentRetention,
  type RetentionSweepResult,
} from '../infrastructure/retentionSweeper'
import { createSqliteUploadSessionStore } from '../infrastructure/sqliteUploadSessionStore'

export function sweepExpiredDevelopmentUploads(db: DbClient, now: number, limit: number): number {
  return createSqliteUploadSessionStore(db).sweepExpired(now, limit)
}

export async function sweepDevelopmentAutomationRetention(
  db: DbClient,
  now: number,
): Promise<RetentionSweepResult> {
  const lookup = createSqliteAdmissionLookup(db)
  return sweepDevelopmentRetention(
    db,
    {
      getPolicyRevisionContent: (id, revision) => lookup.getPolicyRevisionContent(id, revision),
    },
    now,
  )
}
