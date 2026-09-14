import type { ResourceAclActorProjection } from '../../domain/resourceAccess'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

/** One requested count: which table, and whether framework built-ins are excluded. */
export interface ResourceCatalogOverviewCountRequest {
  readonly kind: CatalogSelectorKind
  readonly excludeBuiltin: boolean
}

/** Provider-owned count projection; rows and query builders never cross it. */
export interface ResourceCatalogOverviewCountPort {
  countVisible(
    actor: ResourceAclActorProjection,
    kind: CatalogSelectorKind,
    options: Readonly<{ excludeBuiltin: boolean }>,
  ): Promise<number>
  /**
   * RFC-359 AC-11（plan §5ef）—— 一次问完多张表的可见计数。
   *
   * 概览页此前对六张资源表各发一条 `count(*)`。实测（run `34816698143` 的
   * `postgresql-query-profile.json`）说明 `/api/overview` 在 PostgreSQL 上超预算的原因**不是
   * 查询代价**——四条任务计数全部走 `Index Only Scan`，库内合计不到 1.6ms——而是**语句条数**：
   * 该端点发 22 条语句（九端点里最多），22 条的 `wallMs` 合计 77.4ms 而端点墙钟 15.5ms，
   * 即约 5 路并发；墙钟 ≈（条数 ÷ 并发度）× 均值，**随条数线性增长**。
   *
   * 六条收成一条 `UNION ALL` ⇒ -5 条。谓词逐张表原样复用 `visibleRowsCondition`，
   * 每张表的判据一个字节没变。
   */
  countVisibleMany(
    actor: ResourceAclActorProjection,
    requests: readonly ResourceCatalogOverviewCountRequest[],
  ): Promise<ReadonlyMap<CatalogSelectorKind, number>>
}
