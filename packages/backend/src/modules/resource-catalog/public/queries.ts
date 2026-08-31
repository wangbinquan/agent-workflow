import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { AgentOperationContext } from './participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { SkillOperationContext } from './participants'
import type { WorkflowOperationContext } from './participants'
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
  DiffSkillVersionsCatalogInput,
  GetSkillCatalogInput,
  GetSkillContentCatalogInput,
  GetSkillVersionContentCatalogInput,
  ListSkillFilesCatalogInput,
  ListSkillVersionsCatalogInput,
  ReadSkillFileCatalogInput,
  SkillCatalogContent,
  SkillCatalogFileNode,
  SkillCatalogResource,
  SkillCatalogVersion,
  SkillCatalogVersionContent,
  SkillCatalogVersionDiff,
  ResourceScopeAccess,
  ResourceSummary,
  ResourceSummaryPage,
  ResourceSummaryQuery,
  GetWorkflowCatalogInput,
  WorkflowCatalogDetail,
  WorkflowCatalogResource,
  GetWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  WorkgroupCatalogResource,
  GetResourcePackageApplyReceipt,
  GetResourcePackagePreview,
  ResourcePackageApplyReceiptView,
  ResourcePackagePreviewView,
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

export interface ResourcePackageQueries {
  getPreview(
    context: QueryContext,
    input: GetResourcePackagePreview,
  ): Promise<ResourcePackagePreviewView>
  getReceipt(
    context: QueryContext,
    input: GetResourcePackageApplyReceipt,
  ): Promise<ResourcePackageApplyReceiptView>
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

export interface SkillQueries {
  list(authority: SkillOperationContext): Promise<readonly SkillCatalogResource[]>
  get(
    authority: SkillOperationContext,
    input: GetSkillCatalogInput,
  ): Promise<SkillCatalogResource | null>
  content(
    authority: SkillOperationContext,
    input: GetSkillContentCatalogInput,
  ): Promise<SkillCatalogContent>
}

export interface SkillFileQueries {
  list(
    authority: SkillOperationContext,
    input: ListSkillFilesCatalogInput,
  ): Promise<readonly SkillCatalogFileNode[]>
  read(
    authority: SkillOperationContext,
    input: ReadSkillFileCatalogInput,
  ): Promise<Readonly<{ path: string; content: string }>>
}

export interface SkillVersionQueries {
  list(
    authority: SkillOperationContext,
    input: ListSkillVersionsCatalogInput,
  ): Promise<readonly SkillCatalogVersion[]>
  diff(
    authority: SkillOperationContext,
    input: DiffSkillVersionsCatalogInput,
  ): Promise<SkillCatalogVersionDiff>
  content(
    authority: SkillOperationContext,
    input: GetSkillVersionContentCatalogInput,
  ): Promise<SkillCatalogVersionContent>
}

export interface WorkflowQueries {
  list(authority: WorkflowOperationContext): Promise<readonly WorkflowCatalogResource[]>
  get(
    authority: WorkflowOperationContext,
    input: GetWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail | null>
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
