import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { CapabilityTemplatePackageCommit } from '../application/ports/capabilityTemplatePersistence'

// RFC-359（apply 引擎合一，plan §5dy）—— 这里原本还有一个
// `createSqliteCapabilityTemplatePackageCommitSync`：**同步**事务里的 SQLite 专属提交臂，
// 唯一消费者是通用 bundle 引擎的 legacy 依赖表。那条引擎退役后它零生产消费者，一并删掉。
// 两个 provider 现在都走下面这个异步参与者。

type PostgresqlTransaction = PersistenceTx

/** Async participant bound to the caller's PostgreSQL aggregate transaction. */
export function createPostgresqlCapabilityTemplatePackageCommit(
  tx: PostgresqlTransaction,
): CapabilityTemplatePackageCommit {
  return {
    async commit(prepared) {
      if (prepared.existing === null) {
        const { capabilityTemplates } = tablesOf(tx)
        await insertOne(tx, capabilityTemplates, prepared.row)
        return
      }
      const { capabilityTemplates } = tablesOf(tx)
      await tx
        .update(capabilityTemplates)
        .set(prepared.row)
        .where(eq(capabilityTemplates.id, prepared.row.id))
    },
  }
}
