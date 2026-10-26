import { isWrapperKind } from '@agent-workflow/shared'
import type { Frame, RunSlot } from './slots'

/** Output identity follows the producing definition, including wrapper outlets. */
export function nodeOutputSlot(
  nodeId: string,
  nodeKind: string | undefined,
  frame: Frame,
): Extract<RunSlot, { kind: 'node' | 'container' }> {
  return { kind: isWrapperKind(nodeKind ?? '') ? 'container' : 'node', nodeId, frame }
}
