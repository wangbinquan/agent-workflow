// RFC-358 —— 意图侧消费工作流图校验的端口。
//
// 图校验的 owner 是 resource-catalog（`validateWorkflowDef` 与它读的整份 inventory 都在
// 那个 bounded context 里）。intent 只经它的 exact public 合同 `validateCandidate` 调用，
// 由 composition 装配；本模块不认识 provider、不认识 legacy 校验器文件。

import type { WorkflowDefinition, WorkflowValidationIssue } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { WorkflowValidationCandidateOverlays } from '@/modules/resource-catalog/public/types'

export interface IntentWorkflowGraphValidationPort {
  validate(input: {
    readonly actor: Actor
    readonly definition: WorkflowDefinition
    readonly currentWorkflow: { readonly id: string; readonly name: string }
    readonly overlays?: WorkflowValidationCandidateOverlays
  }): Promise<Readonly<{ ok: boolean; issues: readonly WorkflowValidationIssue[] }>>
  /**
   * RFC-358 §12（决策 D6）—— 「谁在引用这些 agent」。
   *
   * 改 agent 的 outputs 会让引用它的**既有**工作流不再可启动，而平台目前只在**删**
   * agent 时有下游守卫（`agent-in-use`），改没有。本 RFC 不拦截——「先改 agent、
   * 再改工作流」是合法的迭代节奏——但用户有权在确认页看到影响面。
   */
  workflowsUsingAgents(input: {
    readonly actor: Actor
    readonly agentIds: readonly string[]
  }): Promise<ReadonlyMap<string, readonly { readonly id: string; readonly name: string }[]>>
}
