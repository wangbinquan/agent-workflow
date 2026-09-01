// Provider-private compatibility surface for the remaining SQLite transport
// implementation. PostgreSQL composition never imports this module; closed
// Promise ports and transaction participants are its production boundary.
export * from 'drizzle-orm'
export * from '@/db/schema'
export { dbTxSync } from '@/db/txSync'
export type { DbTxSync as LegacySqliteTaskTransaction } from '@/db/txSync'
export type { DbClient as LegacySqliteTaskDatabase } from '@/db/client'
