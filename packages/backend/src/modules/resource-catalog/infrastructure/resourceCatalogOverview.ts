// RFC-359 W4-B2 —— 目录概览的可见计数：一份实现，两个 provider 共用。

import { and, count, eq, sql, type SQL } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, workflows } from '@/db/schema'
import type {
  ResourceCatalogOverviewCountPort,
  ResourceCatalogOverviewCountRequest,
} from '../application/ports/resourceCatalogOverview'
import type { ResourceAclActorProjection } from '../domain/resourceAccess'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { ACL_TABLES, visibleRowsCondition } from './resourceVisibility'

function builtinCondition(kind: CatalogSelectorKind, exclude: boolean): SQL<unknown> | undefined {
  if (!exclude) return undefined
  if (kind === 'agent') return eq(agents.builtin, false)
  if (kind === 'workflow') return eq(workflows.builtin, false)
  return undefined
}

export function createResourceCatalogOverviewCountPort(
  db: ProviderNeutralDatabase,
): ResourceCatalogOverviewCountPort {
  return Object.freeze({
    async countVisible(
      actor: ResourceAclActorProjection,
      kind: CatalogSelectorKind,
      options: Readonly<{ excludeBuiltin: boolean }>,
    ): Promise<number> {
      const table = ACL_TABLES[kind]
      const rows = await db
        .select({ total: count() })
        .from(table)
        .where(
          and(
            visibleRowsCondition(db, actor, kind, table),
            builtinCondition(kind, options.excludeBuiltin),
          ),
        )
      return Number(rows[0]?.total ?? 0)
    },

    /**
     * RFC-359 AC-11（plan §5ef）—— 一条 `UNION ALL` 问完所有表，取代逐表一条 `count(*)`。
     *
     * 每个分支的 where 逐字复用上面那条单表路径的两个判据（`visibleRowsCondition` +
     * `builtinCondition`），所以**可见性阶梯一个字节没变**——变的只有往返次数。
     * `unionAll` 是 drizzle 的方言中立构造，两个 provider 生成各自的标准 SQL。
     */
    async countVisibleMany(
      actor: ResourceAclActorProjection,
      requests: readonly ResourceCatalogOverviewCountRequest[],
    ): Promise<ReadonlyMap<CatalogSelectorKind, number>> {
      const totals = new Map<CatalogSelectorKind, number>()
      if (requests.length === 0) return totals
      const branchFor = (request: ResourceCatalogOverviewCountRequest) => {
        const table = ACL_TABLES[request.kind]
        return db
          .select({ kind: sql<string>`${request.kind}`.as('kind'), total: count().as('total') })
          .from(table)
          .where(
            and(
              visibleRowsCondition(db, actor, request.kind, table),
              builtinCondition(request.kind, request.excludeBuiltin),
            ),
          )
      }
      const [first, ...rest] = requests
      if (first === undefined) return totals
      const head = branchFor(first)
      // 单张表时不套 UNION：一条分支的 `unionAll` 在两个方言上都只是多一层包装。
      const rows =
        rest.length === 0
          ? await head
          : await rest.reduce<ReturnType<typeof branchFor> | ReturnType<typeof head.unionAll>>(
              (left, request) => left.unionAll(branchFor(request)) as never,
              head,
            )
      for (const row of rows as ReadonlyArray<{ kind: string; total: unknown }>) {
        totals.set(row.kind as CatalogSelectorKind, Number(row.total ?? 0))
      }
      return totals
    },
  })
}
