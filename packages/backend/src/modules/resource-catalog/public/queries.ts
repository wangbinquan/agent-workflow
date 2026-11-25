import type { FileNode, Workflow, Workgroup } from '@agent-workflow/shared'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { AgentOperationContext } from './participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { SkillOperationContext } from './participants'
import type { WorkflowOperationContext } from './participants'
import type { WorkgroupOperationContext } from './participants'
import type {
  AgentCatalogResource,
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
  ValidateWorkflowCandidateCatalogInput,
  ValidateWorkflowDraftCatalogInput,
  GetWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  ResourceSummary,
  CatalogResourceRef,
  ResourceSummaryPage,
  ResourceSummaryQuery,
} from './types'

/** Provider-neutral classic-six selector shared by Intent selection and dump. */
export interface ResourceCatalogQuery {
  listVisible(context: QueryContext, query: ResourceSummaryQuery): Promise<ResourceSummaryPage>
  getVisibleSummary(context: QueryContext, ref: CatalogResourceRef): Promise<ResourceSummary | null>
}

export interface AgentQueries {
  list(authority: AgentOperationContext): Promise<readonly AgentCatalogResource[]>
  get(
    authority: AgentOperationContext,
    input: GetAgentCatalogInput,
  ): Promise<AgentCatalogResource | null>
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
  /**
   * RFC-358 —— 校验一份**尚未落库**的候选定义（意图链路）。
   *
   * 与 `validateDraft` 的差别有两处，都源于「意图会话在提交前没有工作流行」：
   *  · 不要求 `workflow: WorkflowCatalogDetail`——create op 的工作流此刻还不存在；
   *  · 不做 reference admission——引用可用性由意图第一层校验与 apply 期的
   *    `assertRefsUsableInTx` 负责，在这里再查一次只会把「同批新建」误判成不可见。
   */
  validateCandidate(
    authority: WorkflowOperationContext,
    input: ValidateWorkflowCandidateCatalogInput,
  ): Promise<WorkflowCatalogValidationResult>
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

/** Closed snapshot of apply operations currently owned by this process. */
export interface ResourcePackageApplyActivityQuery {
  activeApplyIds(): readonly string[]
}

// RFC-467: `validateAgentDependencies` left this entry point — its only outside reader (`services/agentDeps`, used only by
// the RFC-349 injection oracle) moved to the test helpers; Resource Catalog's own agent application imports it directly.

// RFC-567: the SQL fragment `workflowNameExpression` left the public (its signature carries a database handle and drizzle
// types). Bootstrap takes it from resource-catalog's composition and hands it to Task Execution's task read models.
// RFC-568: the two factories that take a database handle — `createAgentExecutionQueries` and
// `createWorkflowExecutionQueries` — left the public too. Bootstrap hands them to the consumers (Task Execution, Intent,
// Knowledge Evolution) as factory references; the closed reads they return stay here.
export type {
  AgentExecutionQueries,
  WorkflowExecutionQueries,
  WorkflowReferenceSummary,
  WorkflowExecutionDocument,
} from '../application/ports/executionResourceQueries'
// RFC-454 — the stored call-closure codec and the launch-input check (pure; task-execution and integration read them).
// RFC-466: `callEdgeKey` left this list with its only outside reader (task-execution's legacy call-closure oracle,
// now a test helper); resource-catalog's own validator reads it from the domain.
// RFC-477: `parseCallClosure` left too — its only outside reader was the trigger preflight, now this module's
// `domain/triggerPreflight.ts` (it reads the codec from the domain).
export {
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
  parseFrozenWorkgroupGroup,
} from '../domain/callClosure'
export { assertWorkflowLaunchInputs } from '../domain/workflowLaunchInputs'
// RFC-477 — trigger dependency preflight over a workflow definition and its frozen call closure (pure). Task-execution
// and integration take it here; it lived in services/execution/triggerPreflight.ts before.
export {
  assertTriggerPreflight,
  triggerPreflightIssue,
  triggerSourceFromContext,
} from '../domain/triggerPreflight'
// RFC-455 — the MCP / plugin operation revision digests (pure; intent's manifest reads them).
export { mcpOperationConfigHashOf } from '../domain/mcpOperationRevision'
export { pluginOperationConfigHashOf } from '../domain/pluginOperationRevision'
// RFC-466 — visibility against a pre-fetched audience snapshot (pure; integration's Digital Employee tool-connection
// catalog reads it, previously through the legacy `services/resourceAcl` facade). It takes the audience authority
// projection, so it is a query-side export: authority types do not cross `public/types` (RFC-294 W0-R).
export { isVisibleToAudienceSnapshot } from '../domain/resourceAccess'
