// RFC-350 —— 不活跃超时收割的 SQLite 具名工厂。
//
// 实现本身在 `taskIdleTimeoutPersistence.ts`：本 adapter 只有纯读 + 两条单语句写、
// 没有事务，两个 provider 的 drizzle query builder 在 `await` 下逐字等价，所以实现
// 共用一份、这里只钉死「SQLite 传的是 DbClient」这件事（bootstrap 选 provider 的
// 入口仍然是两个不同的具名工厂，与 taskArchive / resourceLimits 的形状一致）。

import type { DbClient } from '@/db/client'

import type { TaskIdleTimeoutPersistence } from '../application/ports/taskIdleTimeoutPersistence'
import { createTaskIdleTimeoutPersistence } from './taskIdleTimeoutPersistence'

export function createSqliteTaskIdleTimeoutPersistence(db: DbClient): TaskIdleTimeoutPersistence {
  return createTaskIdleTimeoutPersistence(db)
}
