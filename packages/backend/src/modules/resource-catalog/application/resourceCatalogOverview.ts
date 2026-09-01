import type { Actor } from '@/auth/actor'
import type { Permission } from '@agent-workflow/shared'
import type { ResourceRequestContext } from '../public/participants'
import type { ResourceCatalogOverviewCounts, ResourceCatalogOverviewQuery } from '../public/queries'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import type { ResourceCatalogOverviewCountPort } from './ports/resourceCatalogOverview'

export interface ResourceCatalogOverviewAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

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
  readonly authority: ResourceCatalogOverviewAuthorityResolver
  readonly counts: ResourceCatalogOverviewCountPort
}): ResourceCatalogOverviewQuery {
  return Object.freeze({
    async load(authority: ResourceRequestContext): Promise<ResourceCatalogOverviewCounts> {
      const actor = input.authority.resolve(authority)
      const load = async (dimension: (typeof dimensions)[number]): Promise<number | null> =>
        actor.permissions.has(dimension.permission)
          ? await input.counts.countVisible(actor, dimension.kind, {
              excludeBuiltin: dimension.builtin,
            })
          : null
      const [agents, skills, mcps, plugins, workflows, workgroups] = await Promise.all([
        load(dimensions[0]),
        load(dimensions[1]),
        load(dimensions[2]),
        load(dimensions[3]),
        load(dimensions[4]),
        load(dimensions[5]),
      ])
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
