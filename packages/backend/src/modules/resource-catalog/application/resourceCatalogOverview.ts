import type { Permission } from '@agent-workflow/shared'
import type { ResourceCatalogOverviewCounts, ResourceCatalogOverviewQuery } from '../public/queries'
import type { ResourceAclActorProjection } from '../domain/resourceAccess'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import type { ResourceCatalogOverviewCountPort } from './ports/resourceCatalogOverview'

const dimensions = Object.freeze([
  Object.freeze({ property: 'agents', kind: 'agent', permission: 'agents:read', builtin: true }),
  Object.freeze({ property: 'skills', kind: 'skill', permission: 'skills:read', builtin: false }),
  Object.freeze({ property: 'mcps', kind: 'mcp', permission: 'mcps:read', builtin: false }),
  Object.freeze({
    property: 'plugins',
    kind: 'plugin',
    permission: 'plugins:read',
    builtin: false,
  }),
  Object.freeze({
    property: 'workflows',
    kind: 'workflow',
    permission: 'workflows:read',
    builtin: true,
  }),
  Object.freeze({
    property: 'workgroups',
    kind: 'workgroup',
    permission: 'workgroups:read',
    builtin: false,
  }),
] as const satisfies readonly Readonly<{
  property: keyof ResourceCatalogOverviewCounts
  kind: CatalogSelectorKind
  permission: Permission
  builtin: boolean
}>[])

export function createResourceCatalogOverviewQuery(input: {
  readonly counts: ResourceCatalogOverviewCountPort
}): ResourceCatalogOverviewQuery {
  return Object.freeze({
    async load(actor: ResourceAclActorProjection): Promise<ResourceCatalogOverviewCounts> {
      // RFC-359 AC-11（plan §5ef）—— 六条 `count(*)` 收成一条 `UNION ALL`。
      //
      // 此前这里是六次 `countVisible`（`Promise.all` 并发）。实测说明 `/api/overview` 在
      // PostgreSQL 上超绝对预算的原因是**语句条数**而不是查询代价：该端点发 22 条语句，
      // 22 条的 `wallMs` 合计 77.4ms 而端点墙钟 15.5ms（约 5 路并发），墙钟 ≈
      //（条数 ÷ 并发度）× 均值，随条数线性增长。见 run `34816698143` 的查询画像。
      //
      // **无权限的维度依旧不发查询、依旧回 `null`**（与计数 0 是两件事，前端据此隐藏整格），
      // 所以请求列表按权限先过滤一遍，再一次问完。
      const permitted = dimensions.filter((dimension) =>
        actor.permissions.has(dimension.permission),
      )
      const totals = await input.counts.countVisibleMany(
        actor,
        permitted.map((dimension) => ({ kind: dimension.kind, excludeBuiltin: dimension.builtin })),
      )
      const load = (dimension: (typeof dimensions)[number]): number | null =>
        actor.permissions.has(dimension.permission) ? (totals.get(dimension.kind) ?? 0) : null
      const [agents, skills, mcps, plugins, workflows, workgroups] = [
        load(dimensions[0]),
        load(dimensions[1]),
        load(dimensions[2]),
        load(dimensions[3]),
        load(dimensions[4]),
        load(dimensions[5]),
      ]
      return Object.freeze({
        agents,
        skills,
        mcps,
        plugins,
        workflows,
        workgroups,
      })
    },
  })
}
