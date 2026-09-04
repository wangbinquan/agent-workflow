// Provider-private compatibility surface for the remaining SQLite transport
// implementation. PostgreSQL composition never imports this module; closed
// Promise ports and transaction participants are its production boundary.
export * from 'drizzle-orm'
export * from '@/db/schema'
export { dbTxSync } from '@/db/txSync'
export type { DbTxSync as LegacySqliteTaskTransaction } from '@/db/txSync'
export type { DbClient as LegacySqliteTaskDatabase } from '@/db/client'
// RFC-357：两个 provider 客户端的公共基类型（定义在平台词汇线 `@/db/query`）。
// legacy `services/` 只能经这层门面认识数据库机制——`databaseMechanismDependencies`
// 判据挡的正是它们直取 `@/db/*`，而这条门面就是被认可的入口。
export type { ProviderNeutralDatabase as LegacyProviderNeutralDatabase } from '@/db/query'
