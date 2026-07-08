// RFC-146 T3 — shared prop contract for the per-kind inspector Edit
// components. This used to be the (file-private) `EditProps` of the 1200-line
// `EditForm` switch inside NodeInspector.tsx; the switch is now the
// `KIND_INSPECTORS` registry (NodeInspector.tsx) over one component per kind.

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

export interface EditProps {
  node: WorkflowNode
  agents: Agent[]
  definition: WorkflowDefinition
  onPatch: (next: WorkflowNode) => void
  /**
   * Apply a multi-field workflow definition change. Used by branches that
   * need to mutate the node + other parts of the definition atomically
   * (e.g. RFC-004 input-node inputKey rename touches inputs[] + edges, and
   * the inputs[] entry edits live outside the node itself).
   */
  onCommitDef: (next: WorkflowDefinition) => void
}
