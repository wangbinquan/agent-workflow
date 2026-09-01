import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'

/** Provider-private aliases for shrinking the legacy SQLite compatibility tail. */
export type LegacySqliteTaskDatabase = DbClient
export type LegacySqliteTaskTransaction = DbTxSync
