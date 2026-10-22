import type {
  GraphDesignActionRequest,
  GraphDesignDocument,
  GraphContentRef,
} from '@agent-workflow/shared'
import type { GraphPlanningBudget } from '../../domain/graph-development/selectViews'

/** Selected TaskExecution runtime owns invocation, materials, cancellation and usage. */
export interface GraphDesignAssistPort {
  generate(input: {
    readonly caseId: string
    readonly request: GraphDesignActionRequest
    readonly document: GraphDesignDocument
    readonly readSet: readonly GraphContentRef[]
    readonly capabilityCatalogJson: string
    readonly planningBudget: GraphPlanningBudget
    readonly signal: AbortSignal
  }): Promise<{ readonly invocationRef: string; readonly outputJson: string }>
}
