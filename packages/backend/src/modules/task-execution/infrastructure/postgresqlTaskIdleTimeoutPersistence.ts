// RFC-350 —— 不活跃超时收割的 PostgreSQL 具名工厂。
// 说明见 `sqliteTaskIdleTimeoutPersistence.ts`：实现共用 `taskIdleTimeoutPersistence.ts`。

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

import type { TaskIdleTimeoutPersistence } from '../application/ports/taskIdleTimeoutPersistence'
import { createTaskIdleTimeoutPersistence } from './taskIdleTimeoutPersistence'

export function createPostgresqlTaskIdleTimeoutPersistence(
  db: PostgresqlDatabaseClient,
): TaskIdleTimeoutPersistence {
  return createTaskIdleTimeoutPersistence(db)
}
