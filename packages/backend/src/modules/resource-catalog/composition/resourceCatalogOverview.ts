import type { Actor } from '@/auth/actor'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceRequestContext } from '../public/participants'
import type { ResourceCatalogOverviewQuery } from '../public/queries'
import { createResourceCatalogOverviewQuery } from '../application/resourceCatalogOverview'
import { createResourceCatalogOverviewCountPort } from '../infrastructure/resourceCatalogOverview'

export interface ResourceCatalogOverviewAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

/**
 * RFC-359 W8：SQLite 侧曾有一个同形的 `composeSqliteResourceCatalogOverviewQuery`，它没有任何
 * 调用方——唯一的「引用」是一条源码文本锁里的字符串。计数端口
 * （`infrastructure/resourceCatalogOverview.ts::createResourceCatalogOverviewCountPort`）本来就
 * 收中立客户端，两个引擎共用；那份摆设已删，只留这一个仍在装配的具名入口。
 */
export function composePostgresqlResourceCatalogOverviewQuery(
  db: PostgresqlDatabaseClient,
  authority: ResourceCatalogOverviewAuthorityResolver,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    authority,
    counts: createResourceCatalogOverviewCountPort(db),
  })
}
