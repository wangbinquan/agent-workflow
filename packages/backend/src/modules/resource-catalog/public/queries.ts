import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { McpOperationContext } from './participants'
import type {
  CatalogResourceRef,
  GetResourceAclRequest,
  GetMcpCatalogInput,
  McpCatalogResource,
  ResourceAclDocument,
  ResourceAclTarget,
  ResourceScopeAccess,
  ResourceSummary,
  ResourceSummaryPage,
  ResourceSummaryQuery,
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

export interface McpQueries {
  list(authority: McpOperationContext): Promise<readonly McpCatalogResource[]>
  get(authority: McpOperationContext, input: GetMcpCatalogInput): Promise<McpCatalogResource | null>
}
