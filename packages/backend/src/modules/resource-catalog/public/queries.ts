import type {
  FileNode,
  ResolveAgentImportRefsRequest,
  ResolveAgentImportRefsResult,
  Workflow,
  Workgroup,
} from '@agent-workflow/shared'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { AgentOperationContext } from './participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { SkillOperationContext } from './participants'
import type { WorkflowOperationContext } from './participants'
import type { WorkgroupOperationContext } from './participants'
import type { ResourceRequestContext } from './participants'
import type {
  AgentCatalogResource,
  AgentDependencyClosureResult,
  AgentReferenceLabels,
  AgentReferenceLabelsInput,
  AgentResourceClosureStatus,
  AgentResourceStatus,
  GetAgentResourceClosureStatusInput,
  GetAgentResourceStatusInput,
  GetAgentCatalogInput,
  GetMcpCatalogInput,
  McpCatalogResource,
  GetPluginCatalogInput,
  PluginCatalogResource,
  DiffSkillVersionsCatalogInput,
  GetSkillCatalogInput,
  GetSkillContentCatalogInput,
  GetSkillVersionContentCatalogInput,
  ListSkillFilesCatalogInput,
  ListSkillVersionsCatalogInput,
  ReadSkillFileCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
  SkillCatalogVersion,
  SkillCatalogVersionContent,
  SkillCatalogVersionDiff,
  GetWorkflowCatalogInput,
  WorkflowCatalogDetail,
  WorkflowCatalogDraftValidationResult,
  WorkflowCatalogValidationResult,
  ValidateStoredWorkflowCatalogInput,
  ValidateWorkflowDraftCatalogInput,
  GetWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  ResourceSummary,
  CatalogResourceRef,
  ResourceSummaryPage,
  ResourceSummaryQuery,
  ResolveAgentDependencyClosureInput,
  ResolveAgentDependencyIdsInput,
  ResolvedAgentDependencyIds,
  ValidateAgentDependenciesInput,
  WorkgroupTaskJsonDocument,
  WorkgroupTaskRef,
} from './types'

/** Provider-neutral classic-six selector shared by Intent selection and dump. */
export interface ResourceCatalogQuery {
  listVisible(context: QueryContext, query: ResourceSummaryQuery): Promise<ResourceSummaryPage>
  getVisibleSummary(context: QueryContext, ref: CatalogResourceRef): Promise<ResourceSummary | null>
}

/** Closed Resource Catalog contribution assembled by the System Overview owner. */
export interface ResourceCatalogOverviewCounts {
  readonly agents: number | null
  readonly skills: number | null
  readonly mcps: number | null
  readonly plugins: number | null
  readonly workflows: number | null
  readonly workgroups: number | null
}

export interface ResourceCatalogOverviewQuery {
  load(authority: ResourceRequestContext): Promise<ResourceCatalogOverviewCounts>
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

/** Provider-neutral Agent dependency traversal and reference admission. */
export interface AgentDependencyQueries {
  closure(
    authority: AgentOperationContext,
    input: ResolveAgentDependencyClosureInput,
  ): Promise<AgentDependencyClosureResult>
  resolveUsableIds(
    authority: AgentOperationContext,
    input: ResolveAgentDependencyIdsInput,
  ): Promise<ResolvedAgentDependencyIds>
  validate(authority: AgentOperationContext, input: ValidateAgentDependenciesInput): Promise<void>
}

/** Provider-neutral projection used by the Agent authoring surface. */
export interface AgentResourceIntegrityQueries {
  status(
    authority: AgentOperationContext,
    input: GetAgentResourceStatusInput,
  ): Promise<AgentResourceStatus>
  closureStatus(
    authority: AgentOperationContext,
    input: GetAgentResourceClosureStatusInput,
  ): Promise<AgentResourceClosureStatus>
}

/** Portable Agent import selector resolution bound to the active provider. */
export interface AgentImportQueries {
  resolve(
    authority: AgentOperationContext,
    input: ResolveAgentImportRefsRequest,
  ): Promise<ResolveAgentImportRefsResult>
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
  ): Promise<readonly FileNode[]>
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
  list(authority: WorkflowOperationContext): Promise<readonly Workflow[]>
  get(
    authority: WorkflowOperationContext,
    input: GetWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail | null>
}

/** Provider-neutral validation inventory and new-reference admission. */
export interface WorkflowValidationQueries {
  validateStored(
    authority: WorkflowOperationContext,
    input: ValidateStoredWorkflowCatalogInput,
  ): Promise<WorkflowCatalogValidationResult>
  validateDraft(
    authority: WorkflowOperationContext,
    input: ValidateWorkflowDraftCatalogInput,
  ): Promise<WorkflowCatalogDraftValidationResult>
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
  list(authority: WorkgroupOperationContext): Promise<readonly Workgroup[]>
  get(
    authority: WorkgroupOperationContext,
    input: GetWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail | null>
}

/** Task-scoped Workgroup room projections encoded as closed JSON documents. */
export interface WorkgroupTaskRoomQueries {
  pendingCount(authority: WorkgroupOperationContext): Promise<WorkgroupTaskJsonDocument>
  pending(authority: WorkgroupOperationContext): Promise<WorkgroupTaskJsonDocument>
  room(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskRef,
  ): Promise<WorkgroupTaskJsonDocument>
}

/** Closed snapshot of apply operations currently owned by this process. */
export interface ResourcePackageApplyActivityQuery {
  activeApplyIds(): readonly string[]
}
