// RFC-358 —— 把 intent 的图校验端口绑到 resource-catalog 的 exact public 合同。
//
// 这里是**唯一**知道「图校验由谁提供」的地方：application 只见端口，domain 连端口都不见。

import type { Actor } from '@/auth/actor'
import type { WorkflowValidationQueries } from '@/modules/resource-catalog/public/queries'
import type { WorkflowOperationContext } from '@/modules/resource-catalog/public/participants'
import type { IntentWorkflowGraphValidationPort } from '@/modules/intent/application/ports/intentWorkflowGraphValidation'

export function composeIntentWorkflowGraphValidation(deps: {
  readonly validationQueries: WorkflowValidationQueries
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
  }
  return Object.freeze(port)
}
