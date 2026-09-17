import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export interface AgentLaunchValidationIssue {
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

/** Provider-selected Resource Catalog seam used by single-agent task launch. */
export interface AgentLaunchResourceOperations {
  loadVisibleAgent(actor: Actor, agentId: string): Promise<Agent | null>
  ensureHostWorkflow(): Promise<void>
  validateHostWorkflow(
    definition: WorkflowDefinition,
    candidate?: AgentLaunchWorkflowValidationCandidate,
  ): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}
