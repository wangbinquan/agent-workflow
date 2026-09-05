// RFC-352（RFC-294 W4-E2）—— repository / repository-group scope 存在性读取。
// RFC-359 W4-D4 起一份实现，两个 provider 共用：读取器绑定统一事务原语的句柄。
//
// 这个对象**不铸 capability**：它只回答「这行还在吗」，由 application 层的唯一 owner 工厂
// （`../application/repositoryScopeAuthorization.ts`）把它包成带私有 brand 的 participant。
// 判据（仅 `resource-acl:bypass` 可管）也只在那一处。

import { eq } from 'drizzle-orm'

import { cachedRepos, repoGroups } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { RepositoryScopeExistenceReads } from '../application/repositoryScopeAuthorization'
import type { RepositoryScopeTarget } from '../public/participants'

const reads: RepositoryScopeExistenceReads<DatabaseTransaction> = {
  async exists(transaction, target: RepositoryScopeTarget) {
    const table = target.kind === 'repo' ? cachedRepos : repoGroups
    const rows = await transaction
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, target.id))
      .limit(1)
    return rows[0] !== undefined
  },
}

// 导出的是**事实读取器**，不是 capability——名字也不叫 `create*`：capability-forge 守卫按
// 「返回敏感类型且名为 create/mint」判定 owner 工厂，而 owner 工厂必须唯一。
// 装配方拿它去调 `createRepositoryScopeAuthorizationInTx` 铸能力。
export const repositoryScopeExistenceReads: RepositoryScopeExistenceReads<DatabaseTransaction> =
  reads
