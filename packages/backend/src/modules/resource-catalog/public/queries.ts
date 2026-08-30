import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { AgentOperationContext } from './participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { WorkgroupOperationContext } from './participants'
import type {
  AgentCatalogResource,
  AgentReferenceLabels,
  AgentReferenceLabelsInput,
  CatalogResourceRef,
  GetResourceAclRequest,
  GetAgentCatalogInput,
  GetMcpCatalogInput,
  McpCatalogResource,
  GetPluginCatalogInput,
  PluginCatalogResource,
  ResourceAclDocument,
  ResourceAclTarget,
  ResourceScopeAccess,
  ResourceSummary,
  ResourceSummaryPage,
  ResourceSummaryQuery,
  GetWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  WorkgroupCatalogResource,
} from './types'

export interface ResourceCatalogQuery {
  listVisible(context: QueryContext, query: ResourceSummaryQuery): Promise<ResourceSummaryPage>
  getVisibleSummary(context: QueryContext, ref: CatalogResourceRef): Promise<ResourceSummary | null>
}

export interface ResourceAclQuery {
  get(context: QueryContext, request: GetResourceAclRequest): Promise<ResourceAclDocument>
}

export interface ResourceAuthorizationQuery {
  accessOf(context: QueryContext, target: ResourceAclTarget): Promise<ResourceScopeAccess>
}

export interface AgentQueries {
  list(authority: AgentOperationContext): Promise<readonly AgentCatalogResource[]>
  get(
    authority: AgentOperationContext,
    input: GetAgentCatalogInput,
  ): Promise<AgentCatalogResource | null>
}

export interface AgentReferenceQueries {
  labels(
    authority: AgentOperationContext,
    input: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels>
}

export interface McpQueries {
  list(authority: McpOperationContext): Promise<readonly McpCatalogResource[]>
  get(authority: McpOperationContext, input: GetMcpCatalogInput): Promise<McpCatalogResource | null>
}

export interface PluginQueries {
  list(authority: PluginOperationContext): Promise<readonly PluginCatalogResource[]>
  get(
    authority: PluginOperationContext,
    input: GetPluginCatalogInput,
  ): Promise<PluginCatalogResource | null>
}

export interface WorkgroupQueries {
  list(authority: WorkgroupOperationContext): Promise<readonly WorkgroupCatalogResource[]>
  get(
    authority: WorkgroupOperationContext,
    input: GetWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail | null>
}
