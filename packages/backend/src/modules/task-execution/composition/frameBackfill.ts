// RFC-354 T4 — composition of the one-shot frame backfill per database provider.

import type { ProviderNeutralDatabase } from '@/db/query'
import { runFrameBackfill, type FrameBackfillReport } from '../application/frameBackfillJob'
import { createFrameBackfillStore } from '../infrastructure/frameBackfillStore'

/**
 * RFC-359 AC-10 —— 这里**没有** provider 标签。
 *
 * 它原本是 `{provider:'sqlite'|…} | {provider:'postgresql'|…}` 的联合，但两个成员的结构
 * 逐字相同、且 `runFrameBackfillOnBoot` 从不读那个字段（下面只用 `database.db`）——
 * 自 RFC-359 W4-B1 存储合一之后它就只是个摆设，却逼着每个调用方写一句
 * `provider === 'sqlite' ? {...} : {...}`（`main.ts` 里那条就是这么来的）。
 * 标签一去，那条分叉自然消失，不需要任何替代判据。
 */
export type FrameBackfillDatabase = { readonly db: ProviderNeutralDatabase }

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
