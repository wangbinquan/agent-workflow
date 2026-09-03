// RFC-354 T4 — composition of the one-shot frame backfill per database provider.

import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { runFrameBackfill, type FrameBackfillReport } from '../application/frameBackfillJob'
import { createPostgresqlFrameBackfillStore } from '../infrastructure/postgresqlFrameBackfillStore'
import { createSqliteFrameBackfillStore } from '../infrastructure/sqliteFrameBackfillStore'

export type FrameBackfillDatabase =
  | { readonly provider: 'sqlite'; readonly db: DbClient }
  | { readonly provider: 'postgresql'; readonly db: PostgresqlDatabaseClient }

export type { FrameBackfillReport }

/**
 * Backfill `node_runs.container_run_id` / `scope_path` (and the clarify rounds'
 * frame) for rows minted before RFC-354. Runs once per database — the
 * completion marker in `maintenance_state` makes later calls a single read;
 * `force` re-walks every task (idempotent: framed rows are left alone).
 */
export async function runFrameBackfillOnBoot(
  database: FrameBackfillDatabase,
  options: { readonly force?: boolean } = {},
): Promise<FrameBackfillReport> {
  const store =
    database.provider === 'sqlite'
      ? createSqliteFrameBackfillStore(database.db)
      : createPostgresqlFrameBackfillStore(database.db)
  return await runFrameBackfill({ store, ...(options.force === true ? { force: true } : {}) })
}
