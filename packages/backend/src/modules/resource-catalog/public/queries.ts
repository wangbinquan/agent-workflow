import type { QueryContext } from '@/modules/identity-access/public/participants'
import type {
  CatalogResourceRef,
  GetResourceAclRequest,
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
