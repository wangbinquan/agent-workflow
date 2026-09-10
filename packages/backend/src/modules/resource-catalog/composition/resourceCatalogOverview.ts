import type { ProviderNeutralDatabase } from '@/db/query'
import type { ResourceCatalogOverviewQuery } from '../public/queries'
import { createResourceCatalogOverviewQuery } from '../application/resourceCatalogOverview'
import { createResourceCatalogOverviewCountPort } from '../infrastructure/resourceCatalogOverview'

/**
 * 目录概览计数的装配入口——**一份，两个 provider 共用**。
 *
 * RFC-359 W8：SQLite 侧曾有一个同形的 `composeSqliteResourceCatalogOverviewQuery`，它没有任何
 * 调用方（唯一的「引用」是一条源码文本锁里的字符串），已删。
 *
 * RFC-359 W57：留下的那个具名入口叫 `composePostgresqlResourceCatalogOverviewQuery`、形参标注
 * `PostgresqlDatabaseClient`——但计数端口
 * （`infrastructure/resourceCatalogOverview.ts::createResourceCatalogOverviewCountPort`）本来就收
 * 中立客户端，函数体里一行方言都没有。那个名字与那个标注是**命名债**，不是分叉
 * （判据见 `docs/dev-gotchas.md`「`PostgresqlDatabaseClient` 不是 PostgreSQL 客户端类型」）。
 * `/api/overview` 两侧收成一份时 SQLite 也要装它，名字与类型一并归中立。
 *
 * 同时去掉了原来的 `authority` 解析器入参：端口现在直接收 actor，见 `public/queries.ts`。
 */
export function composeResourceCatalogOverviewQuery(
  db: ProviderNeutralDatabase,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    counts: createResourceCatalogOverviewCountPort(db),
  })
}
