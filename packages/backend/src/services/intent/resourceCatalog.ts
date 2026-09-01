// RFC-235 v22 — actor-filtered resource labels for mounted-context and
// agent-suggested mount resolution. This is a display/selection projection;
// final approval still rechecks ACL in the write transaction.

import type { AclResourceType, FileNode } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type {
  DirectAuthenticatedAuthority,
  QueryContext,
} from '@/modules/identity-access/public/participants'
import type {
  AgentQueries,
  McpQueries,
  PluginQueries,
  ResourceCatalogQuery,
  SkillFileQueries,
  SkillQueries,
  WorkflowQueries,
  WorkgroupQueries,
} from '@/modules/resource-catalog/public/queries'
import type {
  AgentCatalogResource,
  GetAgentCatalogInput,
  GetMcpCatalogInput,
  GetPluginCatalogInput,
  GetSkillContentCatalogInput,
  GetWorkflowCatalogInput,
  GetWorkgroupCatalogInput,
  ListSkillFilesCatalogInput,
  McpCatalogResource,
  PluginCatalogResource,
  ReadSkillFileCatalogInput,
  ResourceCatalogCursor,
  ResourceSummary,
  SkillCatalogContent,
  WorkflowCatalogDetail,
  WorkgroupCatalogDetail,
} from '@/modules/resource-catalog/public/types'
import type {
  IntentContextResourceAuthorization,
  IntentContextResourceAuthorityPair,
} from '@/modules/intent/public/operations'

export interface IntentVisibleResource {
  resourceType: AclResourceType
  resourceId: string
  name: string
  description: string | null
}

/**
 * Exact classic-six detail face consumed only after the summary query has
 * proved that a mounted/closure ref is visible.  Each field is the aggregate's
 * own typed query service; there is deliberately no generic detail union or
 * row loader here.
 */
export interface IntentResourceCatalogDetailQueries {
  readonly agents: Readonly<{
    get(input: GetAgentCatalogInput): Promise<AgentCatalogResource | null>
  }>
  readonly skills: Readonly<{
    content(input: GetSkillContentCatalogInput): Promise<SkillCatalogContent>
  }>
  readonly skillFiles: Readonly<{
    list(input: ListSkillFilesCatalogInput): Promise<readonly FileNode[]>
    read(input: ReadSkillFileCatalogInput): Promise<Readonly<{ path: string; content: string }>>
  }>
  readonly mcps: Readonly<{
    get(input: GetMcpCatalogInput): Promise<McpCatalogResource | null>
  }>
  readonly plugins: Readonly<{
    get(input: GetPluginCatalogInput): Promise<PluginCatalogResource | null>
  }>
  readonly workflows: Readonly<{
    get(input: GetWorkflowCatalogInput): Promise<WorkflowCatalogDetail | null>
  }>
  readonly workgroups: Readonly<{
    get(input: GetWorkgroupCatalogInput): Promise<WorkgroupCatalogDetail | null>
  }>
}

/** Exact Resource Catalog face consumed by both Intent selector and dump. */
export interface IntentResourceCatalogBinding {
  readonly query: ResourceCatalogQuery
  readonly context: QueryContext
  readonly currentAuthority: IntentContextResourceAuthorityPair
  readonly details: IntentResourceCatalogDetailQueries
}

export interface IntentResourceCatalogFactoryDependencies {
  readonly query: ResourceCatalogQuery
  readonly contextFor: (actor: Actor) => QueryContext
  readonly authorityFor: (actor: Actor) => DirectAuthenticatedAuthority
  readonly catalogs: Readonly<{
    agents: Pick<AgentQueries, 'get'>
    skills: Pick<SkillQueries, 'content'>
    skillFiles: Pick<SkillFileQueries, 'list' | 'read'>
    mcps: Pick<McpQueries, 'get'>
    plugins: Pick<PluginQueries, 'get'>
    workflows: Pick<WorkflowQueries, 'get'>
    workgroups: Pick<WorkgroupQueries, 'get'>
  }>
}

export type IntentResourceCatalogFor = (actor: Actor) => IntentResourceCatalogBinding

/** Bootstrap composition helper; it stores only already-composed public handles. */
export function bindIntentResourceCatalog(
  input: IntentResourceCatalogBinding,
): IntentResourceCatalogBinding {
  return Object.freeze({
    query: input.query,
    context: input.context,
    currentAuthority: input.currentAuthority,
    details: Object.freeze({ ...input.details }),
  })
}

/**
 * Binds one request actor to the already-composed provider Resource Catalog.
 * The aggregate holds only public query participants and branded identity
 * contexts, so both SQLite and PostgreSQL bootstrap use the same closed seam.
 */
export function composeIntentResourceCatalogFor(
  input: IntentResourceCatalogFactoryDependencies,
): IntentResourceCatalogFor {
  return (actor) => {
    const authority = input.authorityFor(actor)
    const context = input.contextFor(actor)
    return bindIntentResourceCatalog({
      query: input.query,
      context,
      currentAuthority: Object.freeze({ authority: context.authority, actor: authority }),
      details: {
        agents: {
          get: (request) => input.catalogs.agents.get(authority, request),
        },
        skills: {
          content: (request) => input.catalogs.skills.content(authority, request),
        },
        skillFiles: {
          list: (request) => input.catalogs.skillFiles.list(authority, request),
          read: (request) => input.catalogs.skillFiles.read(authority, request),
        },
        mcps: {
          get: (request) => input.catalogs.mcps.get(authority, request),
        },
        plugins: {
          get: (request) => input.catalogs.plugins.get(authority, request),
        },
        workflows: {
          get: (request) => input.catalogs.workflows.get(authority, request),
        },
        workgroups: {
          get: (request) => input.catalogs.workgroups.get(authority, request),
        },
      },
    })
  }
}

export async function listAllVisibleResourceSummaries(
  binding: IntentResourceCatalogBinding,
): Promise<readonly ResourceSummary[]> {
  const out: ResourceSummary[] = []
  let cursor: ResourceCatalogCursor | undefined
  do {
    const page = await binding.query.listVisible(binding.context, {
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    })
    out.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return out
}

export async function listVisibleIntentResources(
  catalog: IntentResourceCatalogBinding,
): Promise<IntentVisibleResource[]> {
  return (await listAllVisibleResourceSummaries(catalog)).map((summary) => ({
    resourceType: summary.kind,
    resourceId: summary.ref.id,
    name: summary.name,
    description: summary.description,
  }))
}

/** Provider-neutral visibility/name preflight for Intent context mutations. */
export function intentResourceVisibility(
  catalog: IntentResourceCatalogBinding,
): IntentContextResourceAuthorization {
  return Object.freeze({
    currentAuthority: catalog.currentAuthority,
    async visible(input: {
      readonly resourceType: string
      readonly resourceId: string
      readonly expectedName?: string
    }) {
      const summaries = await listAllVisibleResourceSummaries(catalog)
      return summaries.some(
        (summary) =>
          summary.kind === input.resourceType &&
          summary.ref.id === input.resourceId &&
          (input.expectedName === undefined || summary.name === input.expectedName),
      )
    },
  })
}
