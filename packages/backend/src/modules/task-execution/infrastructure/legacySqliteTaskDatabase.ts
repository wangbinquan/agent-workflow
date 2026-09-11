import type { DbClient } from '@/db/client'

/** Provider-private alias for shrinking the legacy SQLite compatibility tail.
 *  RFC-359：同批的 `LegacySqliteTaskTransaction`（`DbTxSync` 的别名）已退役——全仓零消费者，
 *  legacy 层的事务面现在只有中立的 `DatabaseTransaction`。 */
export type LegacySqliteTaskDatabase = DbClient
