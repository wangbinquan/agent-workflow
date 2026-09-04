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
}
