import type { NodeKind, WorkflowNode } from '@agent-workflow/shared'

export type NodeOfKind<K extends NodeKind> = WorkflowNode & { readonly kind: K }

/** Stable task facts needed to address one node execution. */
export interface NodeExecutionTaskRef {
  readonly taskId: string
}

/** The graph scope containing the ready node. */
export interface NodeExecutionScopeRef {
  readonly scopeId: string | null
}

/** Per-dispatch execution facts; capabilities are constructor-injected ports. */
export interface NodeExecutionContextRef {
  readonly signal?: AbortSignal
}

export interface NodeStepRequest<K extends NodeKind = NodeKind> {
  readonly node: NodeOfKind<K>
  readonly task: NodeExecutionTaskRef
  readonly scope: NodeExecutionScopeRef
  readonly iteration: number
  readonly execution: NodeExecutionContextRef
}

/** W2-C keeps the legacy five-way result shape byte-for-byte. */
export interface NodeStepOutcome {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly summary: string
  readonly message: string
  readonly processUnreaped?: true
}
