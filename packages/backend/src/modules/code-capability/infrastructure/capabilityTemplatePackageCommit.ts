import { eq } from 'drizzle-orm'

import { capabilityTemplates } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CapabilityTemplatePackageCommit } from '../application/ports/capabilityTemplatePersistence'

// RFC-359（apply 引擎合一，plan §5dy）—— 这里原本还有一个
// `createSqliteCapabilityTemplatePackageCommitSync`：**同步**事务里的 SQLite 专属提交臂，
// 唯一消费者是通用 bundle 引擎的 legacy 依赖表。那条引擎退役后它零生产消费者，一并删掉。
// 两个 provider 现在都走下面这个异步参与者。

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

/** Async participant bound to the caller's PostgreSQL aggregate transaction. */
export function createPostgresqlCapabilityTemplatePackageCommit(
  tx: PostgresqlTransaction,
): CapabilityTemplatePackageCommit {
  return {
    async commit(prepared) {
      if (prepared.existing === null) {
        await tx.insert(capabilityTemplates).values(prepared.row)
        return
      }
      await tx
        .update(capabilityTemplates)
        .set(prepared.row)
        .where(eq(capabilityTemplates.id, prepared.row.id))
    },
  }
}
