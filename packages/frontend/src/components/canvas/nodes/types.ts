// Shared data shape for custom xyflow node components. The canvas
// pre-computes ports from the workflow definition + agents lookup so node
// components stay dumb.

import type { NodeKind } from '@agent-workflow/shared'

export interface CanvasNodeData extends Record<string, unknown> {
  /** Workflow node id (mirrors xyflow node.id). */
  nodeId: string
  /** Original workflow node kind. */
  kind: NodeKind
  /** Human-readable label (agent name / input key / etc.). */
  title: string
  /** Optional second line (defaults to the node id). */
  subtitle?: string
  /** Output ports declared by this node (rendered on the right). */
  outputPorts: string[]
  /** Input ports declared by this node (rendered on the left). */
  inputPorts: string[]
  /**
   * Status color hint — populated by the task-detail canvas later. v1
   * editor leaves this `undefined` for the neutral default.
   */
  status?: 'pending' | 'running' | 'done' | 'failed' | 'canceled' | 'skipped'
}
