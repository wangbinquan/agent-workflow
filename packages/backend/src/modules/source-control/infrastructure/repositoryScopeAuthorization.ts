// RFC-352（RFC-294 W4-E2）—— repository / repository-group scope 存在性读取的两个 provider 实现。
//
// 这两个函数**不铸 capability**：它们只回答「这行还在吗」，由 application 层的唯一 owner 工厂
// （`../application/repositoryScopeAuthorization.ts`）把它们包成带私有 brand 的 participant。
// 判据（仅 `resource-acl:bypass` 可管）也只在那一处，两个 provider 共用。

import { eq } from 'drizzle-orm'

import { cachedRepos, repoGroups } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { RepositoryScopeExistenceReads } from '../application/repositoryScopeAuthorization'
import type { RepositoryScopeTarget } from '../public/participants'

/** provider 事务句柄——与 memory 侧同源推导，避免两处各写一份结构类型。 */
type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

const sqliteReads: RepositoryScopeExistenceReads<DbTxSync> = {
  exists(transaction, target: RepositoryScopeTarget) {
    const row =
      target.kind === 'repo'
        ? transaction
            .select({ id: cachedRepos.id })
            .from(cachedRepos)
            .where(eq(cachedRepos.id, target.id))
            .get()
        : transaction
            .select({ id: repoGroups.id })
            .from(repoGroups)
            .where(eq(repoGroups.id, target.id))
            .get()
    return row !== undefined
  },
}

const postgresqlReads: RepositoryScopeExistenceReads<PostgresqlTransaction> = {
  async exists(transaction, target: RepositoryScopeTarget) {
    const table = target.kind === 'repo' ? cachedRepos : repoGroups
    const rows = await transaction
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, target.id))
      .limit(1)
      .all()
    return rows[0] !== undefined
  },
}

// 导出的是**事实读取器**，不是 capability——名字也不叫 `create*`：capability-forge 守卫按
// 「返回敏感类型且名为 create/mint」判定 owner 工厂，而 owner 工厂必须唯一。
// 装配方拿这两个 reads 去调 `createRepositoryScopeAuthorizationInTx` 铸能力。
export const sqliteRepositoryScopeExistenceReads: RepositoryScopeExistenceReads<DbTxSync> =
  sqliteReads

export const postgresqlRepositoryScopeExistenceReads: RepositoryScopeExistenceReads<PostgresqlTransaction> =
  postgresqlReads
