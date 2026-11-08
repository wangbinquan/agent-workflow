import type { Agent, WorkflowDefinition, WorkflowDetail } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export interface AgentLaunchValidationIssue {
  /** RFC-470: the stable rule code (resource-catalog's issues always carry it); the sync preview reports it. */
  readonly code: string
  readonly severity?: string
  readonly message: string
  readonly [key: string]: unknown
}

/** Provider-selected visible Agent projection bound to the current authority model. */
export interface AgentLaunchVisibleAgentQuery {
  get(actor: Actor, agentId: string): Promise<Agent | null>
}

/**
 * 启动期静态校验的候选上下文（RFC-359 AC-1，plan §5hn 批次二 ④）。
 *
 * 不给它，`loadWorkflowValidationContext` 就不会填 `ctx.callWorkflows` /
 * `callWorkgroupNames` / `currentWorkflow`——**call-node 规则因此不在这道门上判**，
 * 引用悬空要等到冻结调用闭包时才被另一个组件以另一个错误码拒掉
 *（PostgreSQL 曾经就是这样：`workflow-call-ref-missing`，而且不带 `issues[]`，
 * 工作流编辑器的校验面板指不到出错节点）。
 */
export interface AgentLaunchWorkflowValidationCandidate {
  readonly definition: WorkflowDefinition
  readonly currentWorkflow: Readonly<{ id: string; name: string }>
  /**
   * RFC-470: the workflow-sync preview judges the call-node rules against the candidate's frozen call closure
   * (resource-catalog's validation context reads it when present).
   */
  readonly frozenClosureJson?: string | null
}

/** Provider-selected full Resource Catalog validation context. */
export interface AgentLaunchWorkflowValidation {
  validate(
    definition: WorkflowDefinition,
    candidate?: AgentLaunchWorkflowValidationCandidate,
  ): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}

/** The ACL facts of a workflow row that the visibility check reads (RFC-099). */
export interface AgentLaunchWorkflowAclRow {
  readonly id: string
  readonly ownerUserId?: string | null
  readonly visibility?: 'public' | 'private'
  readonly builtin?: boolean | null
}

/** Provider-selected Resource Catalog seam used by single-agent task launch. */
export interface AgentLaunchResourceOperations {
  loadVisibleAgent(actor: Actor, agentId: string): Promise<Agent | null>
  /** RFC-466: workflow visibility for the task workflow-sync routes (the same resource-catalog
   * view policy the agent lookup applies). */
  canViewWorkflow(actor: Actor, workflow: AgentLaunchWorkflowAclRow): Promise<boolean>
  /** RFC-470: the workflow row by id for the task workflow-sync routes (no visibility check — `canViewWorkflow` judges it,
   * so the routes keep telling `workflow-deleted` from `workflow-not-visible`). */
  readWorkflow(workflowId: string): Promise<WorkflowDetail | null>
  validateHostWorkflow(
    definition: WorkflowDefinition,
    candidate?: AgentLaunchWorkflowValidationCandidate,
  ): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}
