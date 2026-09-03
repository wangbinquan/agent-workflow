// RFC-352（RFC-294 W4-E2）—— `RepositoryScopeAuthorizationInTx` 的两个 provider 实现。
//
// 这是 memory 之前直接 select `cachedRepos` / `repoGroups` 的那段查询搬过来的落点：
// 两张表属 source-control，跨 context 直读它们是 RFC-294 明令禁止的形状。
//
// 判据本身**逐字保持迁移前**：repo / repo_group scope 的管理权 = 仅 `resource-acl:bypass`
// （RFC-248 / RFC-305）。这里不做任何加固、也不引入仓库属主委派。

import { eq } from 'drizzle-orm'

import { cachedRepos, repoGroups } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

/** provider 事务句柄——与 memory 侧同源推导，避免两处各写一份结构类型。 */
type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
import type {
  RepositoryScopeAuthorizationInTx,
  RepositoryScopeSubject,
  RepositoryScopeTarget,
} from '../public/participants'

/**
 * 唯一的判据点。两个 provider 共用它，避免重蹈 memory 那两份 scope 级联各自漂移的覆辙
 * （RFC-352 实测：同一段判据抄两遍之后，SQLite 与 PostgreSQL 对同一个用户给出了不同答案）。
 */
function canManageRepositoryScope(subject: RepositoryScopeSubject): boolean {
  return subject.hasResourceAclBypass
}

export function createSqliteRepositoryScopeAuthorization(): RepositoryScopeAuthorizationInTx<DbTxSync> {
  return {
    exists(transaction, target) {
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
    canManage(_transaction, subject) {
      return canManageRepositoryScope(subject)
    },
  }
}

export function createPostgresqlRepositoryScopeAuthorization(): RepositoryScopeAuthorizationInTx<PostgresqlTransaction> {
  return {
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
    canManage(_transaction, subject) {
      return canManageRepositoryScope(subject)
    },
  }
}
