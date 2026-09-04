// RFC-358 —— 把 intent 的图校验端口绑到 resource-catalog 的 exact public 合同。
//
// 这里是**唯一**知道「图校验由谁提供」的地方：application 只见端口，domain 连端口都不见。

import type { Actor } from '@/auth/actor'
import type {
  WorkflowQueries,
  WorkflowValidationQueries,
} from '@/modules/resource-catalog/public/queries'
import type { WorkflowOperationContext } from '@/modules/resource-catalog/public/participants'
import type { IntentWorkflowGraphValidationPort } from '@/modules/intent/application/ports/intentWorkflowGraphValidation'

export function composeIntentWorkflowGraphValidation(deps: {
  readonly validationQueries: WorkflowValidationQueries
  readonly workflowQueries: WorkflowQueries
  readonly authorityFor: (actor: Actor) => WorkflowOperationContext
}): IntentWorkflowGraphValidationPort {
  const port: IntentWorkflowGraphValidationPort = {
    async validate(input) {
      const result = await deps.validationQueries.validateCandidate(
        deps.authorityFor(input.actor),
        {
          definition: input.definition,
          currentWorkflow: input.currentWorkflow,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
        },
      )
      return Object.freeze({ ok: result.ok, issues: result.issues })
    },

    // 只看 actor 可见的工作流——这是给人的知情提示，不该泄露看不见的资源。
    async workflowsUsingAgents(input) {
      const wanted = new Set(input.agentIds)
      if (wanted.size === 0) return new Map()
      const rows = await deps.workflowQueries.list(deps.authorityFor(input.actor))
      const byAgent = new Map<string, { readonly id: string; readonly name: string }[]>()
      for (const row of rows) {
        for (const node of row.definition.nodes ?? []) {
          const agentId = (node as { agentId?: unknown }).agentId
          if (typeof agentId !== 'string' || !wanted.has(agentId)) continue
          const list = byAgent.get(agentId) ?? []
          if (!list.some((each) => each.id === row.id)) list.push({ id: row.id, name: row.name })
          byAgent.set(agentId, list)
        }
      }
      return byAgent
    },
  }
  return Object.freeze(port)
}
