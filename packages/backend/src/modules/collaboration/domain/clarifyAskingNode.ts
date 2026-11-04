// RFC-442: the clarify-asking-node check is a pure function of the frozen snapshot, so it lives in
// the domain (it used to sit in the infrastructure adapter and reach routes through a legacy
// `services/` re-export). Routes take it from `public/queries`.

import { isClarifyAskingNode, type WorkflowDefinition } from '@agent-workflow/shared'

/**
 * RFC-122: is `nodeId` an asking-agent node in the task's frozen workflow
 * snapshot (the JSON the route holds as a string)? Owns the JSON.parse so the
 * route never casts an `unknown` to `WorkflowDefinition` (RFC-054 W1-7). Returns
 * false on unparseable JSON — the route then surfaces the appropriate 422.
 */
export function isAskingNodeInSnapshot(snapshotJson: string, nodeId: string): boolean {
  let definition: WorkflowDefinition
  try {
    definition = JSON.parse(snapshotJson) as WorkflowDefinition
  } catch {
    return false
  }
  return isClarifyAskingNode(definition, nodeId)
}
