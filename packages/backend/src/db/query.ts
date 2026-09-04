// Platform persistence query vocabulary used by transitional bounded-context
// application code. Keeping the ORM constructors behind this platform edge
// avoids coupling application modules to the transport package while RFC-294
// W2 moves the remaining row projections into infrastructure adapters.
export { and, desc, eq, inArray, ne } from 'drizzle-orm'

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as schema from './schema'

/**
 * RFC-357 —— 两个 provider 客户端的公共基类型。
 *
 * `DbClient`（bun:sqlite，同步）与 `PostgresqlDatabaseClient`（remote，异步，实际上是
 * drizzle 的 sqlite-proxy）都可赋值给它，于是同一段 query builder / `db.all(sql)` 在
 * `await` 之后两边行为一致。先例见 RFC-350 的 `taskIdleTimeoutPersistence.ts`。
 *
 * 放在这条平台词汇线上而不是某个模块里：它是**持久化的词汇**，不是谁的领域概念；
 * 定义在模块内会让每个跨模块使用者都记一条「legacy 指向模块内部」的越界边。
 */
export type ProviderNeutralDatabase = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>
