// RFC-354 T4 — composition of the one-shot frame backfill per database provider.

import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { runFrameBackfill, type FrameBackfillReport } from '../application/frameBackfillJob'
import { createFrameBackfillStore } from '../infrastructure/frameBackfillStore'

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
  // RFC-359 W4-B1：存储只有一份实现，两个 provider 的客户端都直接可用。
  const store = createFrameBackfillStore(database.db)
  return await runFrameBackfill({ store, ...(options.force === true ? { force: true } : {}) })
}
