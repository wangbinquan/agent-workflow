// Shared data shape for custom xyflow node components. The canvas
// pre-computes ports from the workflow definition + agents lookup so node
// components stay dumb.

import type { ClarifyDirective, NodeKind } from '@agent-workflow/shared'

/** Catch-all left-side handle id. WorkflowCanvas.handleConnect translates
 * a connection landing here into target.portName = source.portName, which
 * is the design default (proposal §3.5). Named handles still take hit
 * priority for fan-in drops; the catch-all just lets the first edge into
 * a fresh node land somewhere. */
export const INBOUND_HANDLE_ID = '__inbound__'

/** Discriminated selection emitted by WorkflowCanvas.onSelect. RFC-003. */
export type CanvasSelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string }

export type WorkflowCanvasSurface = 'editor' | 'task' | 'workgroup-preview'

export interface CanvasNodeData extends Record<string, unknown> {
  /** Explicit scope prevents editor-only authoring chrome leaking into runtime canvases. */
  surface: WorkflowCanvasSurface
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
  /** Current-revision validation counts. Omitted for stale/task/preview canvases. */
  validation?: { errors: number; warnings: number }
  /**
   * RFC-106: while a connection is being dragged over this node, the name of
   * the NEW input port the drop will create. Rendered as a live preview port
   * row (identical to a real one) so the author sees exactly what will be wired
   * before releasing. Injected during the drag and cleared on drag end. Absent
   * when nothing is being dragged onto this node.
   */
  previewInputPort?: string
  /**
   * RFC-106: while a precise drop onto an EXISTING input port is hovered, the
   * name of that port — PortHandles highlights its row so the author sees the
   * drop will REUSE it (rather than add a new input). Mutually exclusive with
   * `previewInputPort`.
   */
  reuseInputPort?: string
  /**
   * Status color hint — populated by the task-detail canvas later. v1
   * editor leaves this `undefined` for the neutral default.
   */
  status?:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'interrupted'
    | 'exhausted'
    // Unified "task is parked here waiting for a human" state — review awaiting a
    // decision (node_run `awaiting_review`) and clarify/cross-clarify awaiting
    // answers (node_run `awaiting_human`) both map to this so the canvas can
    // highlight them with one amber-pulse treatment. Clarify/CrossClarifyNode
    // translate it back to their own `awaiting_human` palette value.
    | 'awaiting'
  /** True when this node sits inside a wrapper-loop body (blue accent). */
  loopBody?: boolean
  /**
   * Mirrored from `WorkflowNode.sourcePort` for agent-multi nodes only.
   * AgentNode reads it to toggle the top-handle's `is-connected` class
   * (RFC-015 §5.3). Other node kinds leave this `undefined`.
   */
  sourcePort?: { nodeId: string; portName: string }
  /**
   * RFC-060 wrapper-fanout only: name of the single input port marked
   * `isShardSource: true` in the WorkflowNode's `inputs[]`. WrapperNodes
   * uses this to render that port row with shard-source chrome (accent
   * stripe + "shard" badge) so authors see at a glance which port drives
   * the fan-out. Undefined on every other node kind.
   */
  shardSourcePort?: string
  /**
   * RFC-120 D13: number of pending (non-terminal) questions that originate at
   * this node. When `> 0` the "asking" node renderers (agent / clarify /
   * cross-clarify) paint a click-to-jump count badge in the top-right corner.
   * Undefined / 0 ⇒ no badge. The task-detail canvas populates it from
   * `GET /api/tasks/:id/questions`; the editor canvas leaves it undefined so a
   * canvas with no counts is byte-for-byte unchanged (golden-lock).
   */
  questionCount?: number
  /**
   * RFC-120 D13: click handler for the question badge — receives this node id.
   * The task-detail canvas threads it through so a badge click jumps to the
   * questions board filtered to this source node. Undefined on the editor
   * canvas (no badge there).
   */
  onQuestionBadgeClick?: (nodeId: string) => void
  /**
   * RFC-122: current per-(task, asking-node) clarify directive for THIS node —
   * 'continue' (default: the agent may clarify) or 'stop' (the runner forces the
   * agent out of mandatory ask-back). Set by the task-detail canvas ONLY on
   * asking-agent nodes (`isClarifyAskingNode`); AgentNode renders the
   * `ClarifyDirectiveToggle` when it is defined. Undefined on the editor canvas
   * and on every non-asking node ⇒ no toggle (golden-lock — byte-for-byte the
   * same canvas as before).
   */
  clarifyDirective?: ClarifyDirective
  /**
   * RFC-122: invoked with (nodeId, next) when the user clicks the other half of
   * the directive toggle. The task-detail canvas threads it through to POST the
   * new directive + optimistically update. Undefined on the editor canvas.
   */
  onClarifyDirectiveToggle?: (nodeId: string, next: ClarifyDirective) => void
  /**
   * RFC-158: review-node click target — only set on `review` kind nodes on the
   * task-detail canvas (from the backend-stamped `reviewNavKind`). 'awaiting' →
   * an open review round; 'decided' → a human conclusion to replay. Presence
   * makes ReviewNode render a click hint + pointer cursor; absence (editor
   * canvas, or a review with no renderable/clickable round) ⇒ no hint, not
   * clickable (golden-lock — editor canvas byte-for-byte unchanged).
   */
  reviewNav?: 'awaiting' | 'decided'
  /**
   * RFC-161: clarify-node click target — only set on `clarify` / `clarify-cross-agent`
   * kind nodes on the task-detail canvas (from the backend-stamped `clarifyNavKind`).
   * 'awaiting' → an open clarify round; 'answered' → the submitted answers to replay.
   * Presence makes Clarify/CrossClarifyNode render a click hint + pointer cursor;
   * absence (editor canvas, or a clarify with no clickable round) ⇒ no hint, not
   * clickable (golden-lock — editor canvas byte-for-byte unchanged).
   */
  clarifyNav?: 'awaiting' | 'answered'
  /** Editable workflow only: opens the shared picker with explicit wrapper scope. */
  onAddInsideWrapper?: (wrapperNodeId: string, trigger?: HTMLElement | null) => void
}
