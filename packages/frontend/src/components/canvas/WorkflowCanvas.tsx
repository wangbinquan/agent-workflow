// Thin xyflow wrapper that round-trips a WorkflowDefinition to/from the
// canvas. Pan/zoom/minimap/controls + Backspace/Delete remove the selection.
//
// Per-kind node components register via the `nodeTypes` prop (P-2-04).
// Each node receives a pre-computed `CanvasNodeData` so the renderer
// doesn't have to crawl the workflow definition or an agents lookup.

import {
  Background,
  type Connection,
  type ConnectionLineComponentProps,
  Controls,
  type Edge,
  getBezierPath,
  MiniMap,
  type Node,
  type NodeChange,
  NodeToolbar,
  type OnDelete,
  type OnConnectEnd,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  ClarifyDirective,
  NodeKind,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowValidationIssue,
} from '@agent-workflow/shared'
import {
  buildNodeAgentLookup,
  declaredPorts,
  isClarifyAskingNode,
  isWrapperKind,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { AgentNode } from './nodes/AgentNode'
import { applyPaste, buildSlice, getClipboard, setClipboard } from './canvasClipboard'
import { classifyClarifyConnection } from './clarifyDragHelper'
import { classifyCrossClarifyConnection } from './crossClarifyDragHelper'
import { existingInputPorts, nextFreeInputPort } from './dropTarget'
import { getNodeBoxes, resolveDropTarget } from './connectResolve'
import { buildControlFlowEdgeIds, CONTROL_FLOW_EDGE_CLASS } from './controlFlowEdge'
import { nodeTitle } from './nodeTitle'
import { ConnectDropHint, type ConnectPreviewTarget } from './ConnectDropHint'
import { WorkflowCanvasEdge, type WorkflowCanvasEdgeData } from './WorkflowCanvasEdge'
import { ClarifyNode } from './nodes/ClarifyNode'
import { CrossClarifyNode } from './nodes/CrossClarifyNode'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { NoticeBanner } from '../NoticeBanner'
import { useManagedLiveRegion } from '../ManagedLiveRegion'
import {
  WorkflowNodePicker,
  type WorkflowNodePickerIntent,
} from '../workflow-editor/WorkflowNodePicker'
import { ConnectionDialog } from '../workflow-editor/ConnectionDialog'
import { InputNode } from './nodes/InputNode'
import {
  deserialize,
  hasCanonicalPaletteIdentity,
  makeNode,
  PALETTE_MIME,
  type PaletteItem,
} from './nodePalette'
import { OutputNode } from './nodes/OutputNode'
import { ReviewNode } from './nodes/ReviewNode'
import {
  INBOUND_HANDLE_ID,
  type CanvasNodeData,
  type CanvasSelection,
  type WorkflowCanvasSurface,
} from './nodes/types'
import { GroupWrapperNode } from './nodes/WrapperNodes'
import {
  buildParentMap,
  buildMeasuredSizesFromXyflowNodes,
  projectDefinitionForXyflow,
  projectXyflowPositionsToAbsolute,
  resolveWrappers,
} from './coordProjection'
import {
  applyMembershipPatch,
  resolveMembershipOnDragStop,
  wrapperDescendantIds,
  type WrapperHitInput,
} from './wrapperMembership'
import { DEFAULT_NODE_SIZE_BY_KIND, fitWrapperToInner } from './wrapperFit'
import {
  centerAnchoredTopLeft,
  effectiveWorkflowNodePosition,
  findOpenPlacement,
} from '../../lib/workflow-placement'
import {
  createWorkflowSemanticContext,
  isWorkflowEdgeInsertable,
  planWorkflowConnection,
  planWorkflowEdgeInsertion,
  type ConnectionRequest,
} from '../../lib/workflow-connection-plan'
import { applyWorkflowTransition, type WorkflowTransition } from '../../lib/workflow-transition'
import { planWorkflowLayout, type WorkflowLayoutSelection } from '../../lib/workflow-layout'
import {
  projectWorkflowValidationIssues,
  type WorkflowValidationCounts,
} from '../../lib/workflow-validation-projection'
import {
  clearWrapperSize,
  isWrapperDeleteSnapshotCurrent,
  snapshotWrapperDelete,
  type WrapperDeleteSnapshot,
} from './wrapperOps'

// RFC-146: `satisfies Record<NodeKind, …>` makes a NodeKind without a canvas
// renderer a compile error — same registry shape as KIND_INSPECTORS
// (NodeInspector.tsx) and the palette descriptor table.
const NODE_TYPES = {
  // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
  'agent-single': AgentNode,
  input: InputNode,
  output: OutputNode,
  'wrapper-git': GroupWrapperNode,
  'wrapper-loop': GroupWrapperNode,
  // RFC-060 — wrapper-fanout reuses GroupWrapperNode container chrome.
  'wrapper-fanout': GroupWrapperNode,
  review: ReviewNode,
  clarify: ClarifyNode,
  'clarify-cross-agent': CrossClarifyNode,
} satisfies Record<NodeKind, ComponentType<never>>

const EDGE_TYPES = { 'workflow-insertable': WorkflowCanvasEdge }

export interface WorkflowCanvasProps {
  /** Required scope keeps editor-only authoring visuals out of runtime canvases. */
  surface: WorkflowCanvasSurface
  definition: WorkflowDefinition
  /**
   * Stable workflow identity stored in semantic clipboard payloads. The edit
   * route always supplies this; isolated stories/tests may omit it and use a
   * local-only identity.
   */
  workflowId?: string
  /** Used to look up agent.outputs when rendering agent nodes. Optional. */
  agents?: Agent[]
  onChange?: (next: WorkflowDefinition, meta?: WorkflowCanvasChangeMeta) => void
  /** Opens the RFC-199 starter surface from the editable empty canvas. */
  onStartFromTemplate?: (trigger: HTMLElement) => void
  /** Coordinates canvas-owned picker/connection dialogs with the editor's one modal controller. */
  onModalSurfaceChange?: (surface: 'palette' | 'connection' | 'confirm' | null) => void
  canUndo?: boolean
  canRedo?: boolean
  /** Canvas-scoped history shortcuts; text controls keep native browser undo. */
  onUndo?: () => void
  onRedo?: () => void
  /**
   * Receives the currently-selected node or edge, or null when nothing
   * (or a multi-selection) is active. Edge selection lets the editor
   * route render an EdgeInspector instead of a NodeInspector (RFC-003).
   */
  onSelect?: (sel: CanvasSelection | null) => void
  readOnly?: boolean
  /** Current-revision editor validation only; stale receipts must be omitted. */
  validationIssues?: readonly WorkflowValidationIssue[]
  /**
   * Map of nodeId → status. Wired into the per-kind renderers'
   * `data-status` attribute so the existing CSS overlay picks the color.
   * Used by the task-detail status view (P-2-12).
   */
  nodeStatuses?: Record<string, CanvasNodeData['status'] | undefined>
  /**
   * RFC-007: task-detail canvas can pass per-review iteration counters so
   * we reject drag-rebinding the inputs of a review that has already gone
   * through one or more iterate/reject rounds (changing the input upstream
   * would invalidate the existing doc_versions; see RFC-005 design §9).
   * Editor canvas leaves this undefined → no lock.
   */
  taskContext?: { reviewIteration: Record<string, number> }
  /**
   * RFC-120 D13: per-node count of questions the node is HANDLING (processing-
   * phase entries whose effective target = override ?? default is this node —
   * 2026-07-02 badge-dimension fix), keyed by workflow node id. Only entries
   * `> 0` paint a count badge (agent / clarify / cross-clarify renderers).
   * Undefined (editor canvas) ⇒ no badges and a byte-for-byte unchanged canvas
   * (golden-lock). Changing this map rebuilds node data the same way
   * `nodeStatuses` does.
   */
  questionCounts?: Record<string, number>
  /**
   * RFC-120 D13: invoked with a node id when that node's question badge is
   * clicked. The task-detail page uses it to switch to the questions board and
   * filter it to this handler node.
   */
  onNodeQuestionBadgeClick?: (nodeId: string) => void
  /**
   * RFC-122: per-(task, asking-node) clarify directive map, keyed by workflow
   * node id. When DEFINED (task-detail canvas) every asking-agent node
   * (`isClarifyAskingNode`) paints a "继续反问 / 停止反问" toggle showing
   * `clarifyDirectives[id] ?? 'continue'`; nodes absent from the map default to
   * 'continue'. Undefined (editor canvas) ⇒ no toggles and a byte-for-byte
   * unchanged canvas (golden-lock). Changing this map rebuilds node data the same
   * way `nodeStatuses` / `questionCounts` do.
   */
  clarifyDirectives?: Record<string, ClarifyDirective>
  /**
   * RFC-122: invoked with (nodeId, next) when an asking node's directive toggle
   * is flipped. The task-detail page POSTs the new directive + invalidates.
   */
  onNodeClarifyDirectiveToggle?: (nodeId: string, next: ClarifyDirective) => void
  /**
   * RFC-158: per review-node click target ('awaiting' | 'decided'), keyed by
   * workflow node id. When DEFINED (task-detail canvas) a review node with an
   * entry renders a click-to-open hint + pointer cursor; nodes absent from the
   * map are not clickable. Undefined (editor canvas) ⇒ no hints and a
   * byte-for-byte unchanged canvas (golden-lock). Changing this map rebuilds
   * node data the same way `nodeStatuses` / `questionCounts` do.
   */
  reviewNavs?: Record<string, 'awaiting' | 'decided'>
  /**
   * RFC-161: per clarify/cross-clarify-node click target ('awaiting' | 'answered'),
   * keyed by workflow node id. When DEFINED (task-detail canvas) a clarify node with
   * an entry renders a click-to-open hint + pointer cursor; nodes absent from the map
   * are not clickable. Undefined (editor canvas) ⇒ no hints, byte-for-byte unchanged
   * (golden-lock). Changing this map rebuilds node data like `reviewNavs` does.
   */
  clarifyNavs?: Record<string, 'awaiting' | 'answered'>
}

export function canShowEdgeInsertAffordance(
  surface: WorkflowCanvasSurface,
  readOnly: boolean | undefined,
  hasChangeHandler: boolean,
): boolean {
  return surface === 'editor' && readOnly !== true && hasChangeHandler
}

export interface WorkflowCanvasChangeMeta {
  label: string
  selectionBefore?: CanvasSelection | null
  selectionAfter?: CanvasSelection | null
}

function singleCanvasSelection(
  nodes: readonly string[],
  edges: readonly string[],
): CanvasSelection | null {
  if (nodes.length === 1 && edges.length === 0) return { kind: 'node', id: nodes[0]! }
  if (edges.length === 1 && nodes.length === 0) return { kind: 'edge', id: edges[0]! }
  return null
}

/**
 * Imperative handle exposed via ref on {@link WorkflowCanvas}. The parent
 * route uses `clearSelection` from inspector close buttons so the edge /
 * node loses its xyflow `selected: true` state and can be re-clicked.
 * Without this the EdgeInspector close (✕) leaves the edge highlighted
 * AND pinned in `lastEmittedSelectionSig`, so xyflow emits no fresh
 * select change on the next click and the inspector never reopens.
 */
export interface WorkflowCanvasHandle {
  addPaletteItemAtViewportCenter: (item: PaletteItem) => void
  openNodePicker: (intent?: WorkflowNodePickerIntent, trigger?: HTMLElement | null) => void
  clearSelection: () => void
  restoreSelection: (selection: CanvasSelection | null) => void
  /** Select and reveal one semantic object without depending on drag/mouse input. */
  focusSelection: (selection: CanvasSelection) => void
  /** Opens the same planner-backed connection Dialog used by the node toolbar. */
  openConnection: (nodeId: string, trigger?: HTMLElement | null) => void
  openEdgeReconnect: (edgeId: string, trigger?: HTMLElement | null) => void
  /** Closes every canvas-owned top-level modal before an external route surface takes ownership. */
  closeModalSurface: () => void
}

/** Screen-space center used by palette click / keyboard insertion. */
export function viewportCenter(rect: {
  left: number
  top: number
  width: number
  height: number
}): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

/** Native text editing always wins over canvas copy/paste/history shortcuts. */
export function isCanvasTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return (
    target.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
    ) !== null
  )
}

export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(
  function WorkflowCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <CanvasInner {...props} handleRef={ref} />
      </ReactFlowProvider>
    )
  },
)

function CanvasInner({
  surface,
  definition,
  workflowId,
  agents,
  onChange,
  onStartFromTemplate,
  onModalSurfaceChange,
  onSelect,
  readOnly,
  validationIssues,
  nodeStatuses,
  taskContext,
  questionCounts,
  onNodeQuestionBadgeClick,
  clarifyDirectives,
  onNodeClarifyDirectiveToggle,
  reviewNavs,
  clarifyNavs,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  handleRef,
}: WorkflowCanvasProps & {
  handleRef?: React.ForwardedRef<WorkflowCanvasHandle>
}) {
  const { t } = useTranslation()
  const managedLiveRegion = useManagedLiveRegion()
  const canvasDescriptionId = useId()
  const [canvasNotice, setCanvasNotice] = useState<string | null>(null)
  const [connectionReplaceEdgeId, setConnectionReplaceEdgeId] = useState<string | null>(null)
  // RFC-223 (PR-3a impl-gate H3): key by BOTH id and name so the shared port /
  // fanout resolvers (which resolve a stamped node strictly by its agentId) hit
  // the id key; a legacy name-only node still hits its name key. (Var kept named
  // `agentByName` — its many downstream consumers only read, and the id keys are
  // ULIDs that never collide with human names.)
  const agentByName = useMemo(() => buildNodeAgentLookup(agents ?? [], (a) => a), [agents])
  const semanticContext = useMemo(() => createWorkflowSemanticContext(agents ?? []), [agents])
  const validationProjection = useMemo(
    () => projectWorkflowValidationIssues(definition, validationIssues),
    [definition, validationIssues],
  )
  const rf = useReactFlow()
  // Direct handle on xyflow's internal store. Used by `clearSelection`
  // below so we go through `unselectNodesAndEdges`, which synchronously
  // mutates `nodeLookup[id].selected = false` AND fires the corresponding
  // `select:false` change events. The previous `setNodes(clearFlowSelection)`
  // path only flipped the React-side `selected` flag; xyflow's internal
  // `handleNodeClick` reads `nodeLookup.get(id).selected`, so a stale
  // `true` there made the next click on the same node a no-op
  // (selected && !multiSelectActive → neither branch fires) and the
  // inspector never reopened.
  const storeApi = useStoreApi()
  // RFC-199: every persisted canvas edit funnels through the one semantic
  // transition. Input declarations, disconnect cascades, review/output
  // mirrors, wrapper membership sizing and derived-port cleanup therefore
  // run once regardless of the interaction entry point.
  const commitTransition = useCallback(
    (transition: WorkflowTransition, meta?: WorkflowCanvasChangeMeta): boolean => {
      if (onChange === undefined) return false
      const result = applyWorkflowTransition(definition, transition, semanticContext)
      const blocked =
        result.next === definition &&
        result.warnings.some(
          (warning) =>
            ('action' in warning && warning.action === 'abort') ||
            warning.code === 'connection-plan-context-stale' ||
            warning.code === 'connection-plan-graph-stale',
        )
      if (blocked) {
        setCanvasNotice(t('canvas.referenceChangeBlocked'))
        return false
      }
      if (result.warnings.length > 0) {
        setCanvasNotice(t('canvas.referencesPruned', { n: result.warnings.length }))
      }
      onChange(result.next, meta ?? { label: t('editor.history.canvasEdit') })
      return true
    },
    [definition, onChange, semanticContext, t],
  )
  const commitChange = useCallback(
    (next: WorkflowDefinition, meta?: WorkflowCanvasChangeMeta): boolean =>
      commitTransition({ kind: 'replace-definition', next }, meta),
    [commitTransition],
  )
  // RFC-120 D13: stable bridge to the latest onNodeQuestionBadgeClick prop. A
  // ref keeps the handle identity-stable across renders so node-data rebuilds
  // (toFlowNodes) don't need the possibly-changing callback in their deps — the
  // badge invokes data.onQuestionBadgeClick captured at rebuild time.
  const questionBadgeClickRef = useRef(onNodeQuestionBadgeClick)
  useEffect(() => {
    questionBadgeClickRef.current = onNodeQuestionBadgeClick
  }, [onNodeQuestionBadgeClick])
  const handleQuestionBadgeClick = useCallback((nodeId: string) => {
    questionBadgeClickRef.current?.(nodeId)
  }, [])
  // RFC-122: identical stable-bridge pattern for the clarify directive toggle —
  // a ref keeps the handle identity-stable so node-data rebuilds (toFlowNodes)
  // don't churn on a changing callback; the toggle invokes the captured handle.
  const clarifyDirectiveToggleRef = useRef(onNodeClarifyDirectiveToggle)
  useEffect(() => {
    clarifyDirectiveToggleRef.current = onNodeClarifyDirectiveToggle
  }, [onNodeClarifyDirectiveToggle])
  const handleClarifyDirectiveToggle = useCallback((nodeId: string, next: ClarifyDirective) => {
    clarifyDirectiveToggleRef.current?.(nodeId, next)
  }, [])

  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({
    nodes: [],
    edges: [],
  })
  const [menu, setMenu] = useState<{
    x: number
    y: number
    nodeId: string | null
  } | null>(null)
  const [nodePickerIntent, setNodePickerIntent] = useState<WorkflowNodePickerIntent | null>(null)
  const [connectionSourceNodeId, setConnectionSourceNodeId] = useState<string | null>(null)
  const [connectionAnnouncement, setConnectionAnnouncement] = useState('')
  const announceCanvasChange = useCallback(
    (message: string) => {
      if (managedLiveRegion === null) setConnectionAnnouncement(message)
      else managedLiveRegion.announce(message)
    },
    [managedLiveRegion],
  )
  const [wrapperDeleteSnapshot, setWrapperDeleteSnapshot] = useState<WrapperDeleteSnapshot | null>(
    null,
  )
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const nodePickerTriggerRef = useRef<HTMLElement | null>(null)
  const connectionTriggerRef = useRef<HTMLElement | null>(null)
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const openNodePickerRef = useRef<
    (intent?: WorkflowNodePickerIntent, trigger?: HTMLElement | null) => void
  >(() => undefined)
  const handleAddInsideWrapper = useCallback(
    (wrapperNodeId: string, trigger?: HTMLElement | null) => {
      openNodePickerRef.current({ kind: 'inside-wrapper', wrapperNodeId }, trigger)
    },
    [],
  )
  const handleInsertNodeOnEdge = useCallback((edgeId: string, trigger: HTMLElement) => {
    openNodePickerRef.current({ kind: 'insert-edge', edgeId }, trigger)
  }, [])
  const edgeInsertEnabled = canShowEdgeInsertAffordance(surface, readOnly, onChange !== undefined)
  // Cached signature of the last selection emitted to the parent. Without
  // this guard we'd hand the parent a fresh `{kind, id}` object on every
  // xyflow tick, the parent re-renders, xyflow's StoreUpdater notices new
  // store refs and re-fires onSelectionChange — infinite loop and React's
  // "Maximum update depth exceeded". String equality on the signature
  // matches the same-content case via `Object.is`.
  const lastEmittedSelectionSig = useRef<string>('null')

  const [nodes, setNodes] = useState<Node[]>(() =>
    projectDefinitionForXyflow(
      definition,
      toFlowNodes(
        definition,
        agentByName,
        nodeStatuses,
        questionCounts,
        handleQuestionBadgeClick,
        clarifyDirectives,
        handleClarifyDirectiveToggle,
        reviewNavs,
        clarifyNavs,
        readOnly !== true && onChange !== undefined ? handleAddInsideWrapper : undefined,
        validationProjection.nodes,
        surface,
      ),
    ),
  )
  const [edges, setEdges] = useState<Edge[]>(() =>
    toFlowEdges(
      definition.edges,
      buildControlFlowEdgeIds(definition, agentByName),
      workflowInsertableEdgeIds(definition, semanticContext),
      {
        surface,
        readOnly,
        hasChangeHandler: onChange !== undefined,
        onInsertNode: handleInsertNodeOnEdge,
      },
      validationProjection.edges,
    ),
  )
  const externalDefRef = useRef(definition)
  const externalSurfaceRef = useRef(surface)
  const externalStatusesRef = useRef(nodeStatuses)
  // RFC-120 D13: mirror of `nodeStatuses`' externalStatusesRef guard — lets the
  // def-sync useEffect rebuild node data when only `questionCounts` changes
  // (badge counts arrive async from the questions query, definition unchanged).
  const externalQuestionCountsRef = useRef(questionCounts)
  // RFC-122: mirror of the questionCounts ref-guard so a directives-only change
  // (toggle POST resolves, definition unchanged) repaints the toggles.
  const externalClarifyDirectivesRef = useRef(clarifyDirectives)
  // RFC-158: mirror of the same ref-guard so a reviewNavs-only change (node-runs
  // query resolves / a review advances, definition unchanged) repaints hints.
  const externalReviewNavsRef = useRef(reviewNavs)
  // RFC-161: mirror of the same ref-guard so a clarifyNavs-only change (node-runs
  // query resolves / a clarify advances, definition unchanged) repaints hints.
  const externalClarifyNavsRef = useRef(clarifyNavs)
  const externalValidationIssuesRef = useRef(validationIssues)
  const externalEdgeInsertEnabledRef = useRef(edgeInsertEnabled)
  // Track the last agentByName ref we rebuilt against. The canvas is often
  // mounted on the task-detail page before the `useQuery(['agents'])` call
  // resolves; on first render `agents` is `[]`, so agent-node `outputPorts`
  // come out empty and no output Handles render. When the query then
  // resolves, the definition reference hasn't changed — so without this
  // ref the rebuild gate below would skip, leaving us permanently stuck
  // with handle-less agent nodes (and xyflow drops every edge whose
  // source/target handle id can't be found — the visible symptom is
  // "coder→review edges missing").
  const externalAgentsRef = useRef(agentByName)
  // Read-only mirror of `selection` for the def-sync useEffect below — we
  // need the current selection at rebuild time but we don't want to add it
  // to the deps (every selection change would re-rebuild every node from
  // the definition).
  const selectionRef = useRef(selection)
  useEffect(() => {
    selectionRef.current = selection
  }, [selection])
  // RFC-016: keep an out-of-band handle on the current xyflow `nodes` so the
  // def-sync useEffect below can pluck the measured sizes (populated by
  // xyflow's ResizeObserver after first render) without subscribing to every
  // dimensions change. Without this, wrappers would always re-fit using the
  // pre-measurement DEFAULT_NODE_SIZE_BY_KIND estimates and could
  // under-grow once agents render with many port rows.
  const nodesRef = useRef<Node[]>(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  // Event callbacks can arrive back-to-back before React commits the previous
  // controlled-state update. Mirror edges as well as nodes so each callback
  // can compute its next state synchronously, then perform setters/commits in
  // an explicit order — never from inside a replayable state updater.
  const edgesRef = useRef<Edge[]>(edges)
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  const handleAutoLayout = useCallback(
    (layoutSelection: WorkflowLayoutSelection) => {
      if (readOnly === true || onChange === undefined) return
      // Freeze the current xyflow measurements at the adapter boundary. Dagre
      // and wrapper fitting only see this detached snapshot; the pure planner
      // never reads live DOM geometry or mutates xyflow state directly.
      const measuredSizes = new Map(
        [...buildMeasuredSizesFromXyflowNodes(nodesRef.current)].map(([id, size]) => [
          id,
          { width: size.width, height: size.height },
        ]),
      )
      const plan = planWorkflowLayout(definition, {
        semanticContext,
        measuredSizes,
        selection: layoutSelection,
      })
      const warningMessages: string[] = []
      const crossScope = plan.warnings.find((warning) => warning.code === 'cross-scope-selection')
      if (crossScope !== undefined) warningMessages.push(t('canvas.layoutCrossScope'))
      const cycleCount = plan.warnings.filter(
        (warning) => warning.code === 'cycle-back-edge',
      ).length
      if (cycleCount > 0) warningMessages.push(t('canvas.layoutCycles', { n: cycleCount }))
      const overflowCount = plan.warnings.filter(
        (warning) => warning.code === 'size-locked-overflow',
      ).length
      if (overflowCount > 0) {
        warningMessages.push(t('canvas.layoutLockedOverflow', { n: overflowCount }))
      }

      if (plan.next === definition) {
        if (warningMessages.length > 0) setCanvasNotice(warningMessages.join(' '))
        return
      }
      const semanticSelection = singleCanvasSelection(selection.nodes, selection.edges)
      const accepted = commitChange(plan.next, {
        label: t('editor.history.autoLayout'),
        selectionBefore: semanticSelection,
        selectionAfter: semanticSelection,
      })
      if (!accepted) return
      if (warningMessages.length > 0) setCanvasNotice(warningMessages.join(' '))
      window.requestAnimationFrame(() => {
        void rf.fitView()
      })
    },
    [
      commitChange,
      definition,
      onChange,
      readOnly,
      rf,
      selection.edges,
      selection.nodes,
      semanticContext,
      t,
    ],
  )

  /**
   * Publish one semantic selection to every owner before a definition rebuild.
   * `selectionRef` is synchronous because the def-sync effect may run before
   * React flushes the local state update; the signature prevents xyflow's
   * subsequent onSelectionChange echo from reopening a render loop.
   */
  const syncCanvasSelection = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]): CanvasSelection | null => {
      const next = buildCanvasSelectionSync(nodeIds, edgeIds)
      selectionRef.current = next.local
      setSelection(next.local)
      lastEmittedSelectionSig.current = next.signature
      onSelect?.(next.route)
      return next.route
    },
    [onSelect],
  )

  // A canvas mounted inside a hidden tab pane (`.task-detail__pane[hidden]`
  // → display:none) measures 0×0, so xyflow resolves its queued init fitView
  // against that degenerate viewport — zoom clamps to minZoom and the nodes
  // land off-screen — and v12 never re-queues the fit when the pane unhides
  // (observed on the dw confirm-gate preview: transform `scale(0.2)`, node
  // clipped above the frame). Detect the hidden mount by measuring
  // SYNCHRONOUSLY on the FIRST effect run — the unhide often happens later in
  // the same React cascade (the task page's default-tab effect), so a
  // ResizeObserver's first async delivery is already post-unhide and can
  // never see the hidden state. The armed flag lives in a ref because the
  // effect re-runs (StrictMode double-invoke; `rf` identity changes) — a
  // re-run must inherit the pending arm, not re-decide it from the now
  // visible wrapper. Only a degenerate first measure arms the observer; the
  // first real size then redoes fitView once. A canvas that mounts visible
  // never arms this, so user pan/zoom is never clobbered.
  const hiddenMountArmRef = useRef<boolean | null>(null)
  useEffect(() => {
    const el = wrapperRef.current
    if (el === null) return
    if (hiddenMountArmRef.current === null) {
      const rect = el.getBoundingClientRect()
      hiddenMountArmRef.current = resolveHiddenMountRefit(null, rect.width, rect.height).armed
    }
    if (hiddenMountArmRef.current !== true) return
    let raf = 0
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry === undefined) return
      const next = resolveHiddenMountRefit(
        hiddenMountArmRef.current,
        entry.contentRect.width,
        entry.contentRect.height,
      )
      hiddenMountArmRef.current = next.armed
      if (!next.refit) return
      ro.disconnect()
      // Next frame: xyflow's own ResizeObservers (same delivery batch) must
      // ingest the new pane dimensions + re-measured node sizes before the
      // fit computes its viewport.
      raf = requestAnimationFrame(() => {
        void rf.fitView()
      })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [rf])

  useEffect(() => {
    const defChanged = definition !== externalDefRef.current
    const surfaceChanged = surface !== externalSurfaceRef.current
    const statusChanged = nodeStatuses !== externalStatusesRef.current
    const agentsChanged = agentByName !== externalAgentsRef.current
    // RFC-120 D13: question-badge counts also drive a node-data rebuild — same
    // ref-guard shape as `statusChanged` so a counts-only change repaints badges.
    const questionsChanged = questionCounts !== externalQuestionCountsRef.current
    // RFC-122: directive map change repaints the toggles (same ref-guard shape).
    const directivesChanged = clarifyDirectives !== externalClarifyDirectivesRef.current
    // RFC-158: reviewNavs map change repaints review-node hints (same shape).
    const reviewNavsChanged = reviewNavs !== externalReviewNavsRef.current
    // RFC-161: clarifyNavs map change repaints clarify-node hints (same shape).
    const clarifyNavsChanged = clarifyNavs !== externalClarifyNavsRef.current
    const validationChanged = validationIssues !== externalValidationIssuesRef.current
    const edgeInsertEnabledChanged = edgeInsertEnabled !== externalEdgeInsertEnabledRef.current
    if (
      defChanged ||
      surfaceChanged ||
      statusChanged ||
      agentsChanged ||
      questionsChanged ||
      directivesChanged ||
      reviewNavsChanged ||
      clarifyNavsChanged ||
      validationChanged ||
      edgeInsertEnabledChanged
    ) {
      externalDefRef.current = definition
      externalSurfaceRef.current = surface
      externalStatusesRef.current = nodeStatuses
      externalAgentsRef.current = agentByName
      externalQuestionCountsRef.current = questionCounts
      externalClarifyDirectivesRef.current = clarifyDirectives
      externalReviewNavsRef.current = reviewNavs
      externalClarifyNavsRef.current = clarifyNavs
      externalValidationIssuesRef.current = validationIssues
      externalEdgeInsertEnabledRef.current = edgeInsertEnabled
      // Preserve `selected: true` across the rebuild. Without this, an
      // inspector edit (which mints a new `definition` reference) wipes
      // the selected flag, xyflow sees a phantom deselect and fires
      // onSelectionChange with `[]` — our handler then calls
      // `onSelect(null)` and the inspector unmounts mid-keystroke.
      const sel = selectionRef.current
      const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
      setNodes(
        applySelection(
          projectDefinitionForXyflow(
            definition,
            toFlowNodes(
              definition,
              agentByName,
              nodeStatuses,
              questionCounts,
              handleQuestionBadgeClick,
              clarifyDirectives,
              handleClarifyDirectiveToggle,
              reviewNavs,
              clarifyNavs,
              readOnly !== true && onChange !== undefined ? handleAddInsideWrapper : undefined,
              validationProjection.nodes,
              surface,
            ),
            measured,
          ),
          sel.nodes,
        ),
      )
      // Rebuild edges on a definition OR agents change. Control-flow tagging
      // (toFlowEdges' second arg) reads agent.outputKinds, which arrive
      // asynchronously once the agents query resolves (see externalAgentsRef
      // above) — without the agentsChanged arm a signal edge stays drawn as a
      // data edge until the next definition edit.
      if (defChanged || agentsChanged || validationChanged || edgeInsertEnabledChanged)
        setEdges(
          applySelection(
            toFlowEdges(
              definition.edges,
              buildControlFlowEdgeIds(definition, agentByName),
              workflowInsertableEdgeIds(definition, semanticContext),
              {
                surface,
                readOnly,
                hasChangeHandler: onChange !== undefined,
                onInsertNode: handleInsertNodeOnEdge,
              },
              validationProjection.edges,
            ),
            sel.edges,
          ),
        )
    }
  }, [
    definition,
    agentByName,
    nodeStatuses,
    questionCounts,
    handleQuestionBadgeClick,
    clarifyDirectives,
    handleClarifyDirectiveToggle,
    handleAddInsideWrapper,
    reviewNavs,
    clarifyNavs,
    edgeInsertEnabled,
    handleInsertNodeOnEdge,
    onChange,
    readOnly,
    semanticContext,
    surface,
    validationIssues,
    validationProjection,
  ])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const reconciled = reconcileFlowNodeChanges(changes, nodesRef.current, edgesRef.current)
      const next = reconciled.nodes
      nodesRef.current = next
      setNodes(next)
      if (readOnly === true || onChange === undefined || !affectsDefinition(changes)) return

      // Only propagate changes that actually affect the persisted workflow
      // definition. xyflow's `select` and `dimensions` changes are local UI
      // state; propagating them would create a definition rebuild loop.
      const previousEdges = edgesRef.current
      const liveEdges = reconciled.edges
      if (liveEdges.length !== previousEdges.length) {
        edgesRef.current = liveEdges
        setEdges(liveEdges)
      }
      const removedIds: string[] = []
      for (const change of changes) {
        if (change.type === 'remove') removedIds.push(change.id)
      }
      // xyflow emits incident edge removals and node removals in two callbacks
      // for one Delete gesture. `onDelete` owns the single semantic
      // transaction; these callbacks only mirror controlled flow state.
      if (removedIds.length === 0) {
        commitChange(toDefinition(definition, next, liveEdges), {
          label: t('editor.history.canvasEdit'),
        })
      }
      // Parent selection is intentionally untouched here. `onDelete` owns the
      // final selection, and no setter/commit runs inside a replayable updater.
    },
    [commitChange, definition, onChange, readOnly, t],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly === true) return
      // Apply ALL change types (select / remove / replace / etc) via xyflow's
      // helper. Compute outside the setter so React cannot replay a commit or
      // a sibling state update as part of a functional updater.
      const next = applyEdgeChanges(changes, edgesRef.current)
      edgesRef.current = next
      setEdges(next)
      if (onChange === undefined || !affectsEdgeDefinition(changes)) return
      const removedIds: string[] = []
      for (const change of changes) {
        if (change.type === 'remove') removedIds.push(change.id)
      }
      // See handleNodesChange: one `onDelete` callback persists the whole
      // node+incident-edge gesture atomically.
      if (removedIds.length === 0) {
        commitChange(toDefinition(definition, nodesRef.current, next), {
          label: t('editor.history.canvasEdit'),
        })
      }
      // Parent selection is finalized once by `onDelete`.
    },
    [commitChange, definition, onChange, readOnly, t],
  )

  const deleteKeyCodes = useMemo(() => ['Backspace', 'Delete'], [])

  // RFC-106: true once onConnect (xyflow snapped to a real handle) has handled
  // the gesture this drag. onConnectEnd reads it to decide whether a body drop
  // (no handle snapped → onConnect never fired) still needs a new-input edge.
  const connectHandledRef = useRef(false)
  // RFC-106: latest pointer (screen px) during a connection drag. onConnect has
  // no event, but the build needs the precise drop point to resolve new-vs-reuse
  // — so we track pointermove from onConnectStart..onConnectEnd. The last move
  // before pointerup ≈ the drop point.
  const connectPointer = useRef<{ x: number; y: number } | null>(null)
  const trackConnectPointer = useCallback((e: PointerEvent) => {
    connectPointer.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (readOnly === true || onChange === undefined) return
      // RFC-106: xyflow fired onConnect ⇒ it snapped to a real handle; the
      // body-drop fallback in onConnectEnd must NOT also fire.
      connectHandledRef.current = true
      let request: ConnectionRequest
      const clarifyDrop = classifyClarifyConnection(definition, conn)
      if (clarifyDrop !== null) {
        const tail = ulid().slice(-6).toLowerCase()
        request = {
          kind: 'clarify-questioner',
          questionerNodeId: clarifyDrop.sourceAgentNodeId,
          clarifyNodeId: clarifyDrop.clarifyNodeId,
          edgeIds: { ask: `clarify_${tail}_ask`, answer: `clarify_${tail}_ans` },
        }
      } else {
        const crossDrop = classifyCrossClarifyConnection(definition, conn)
        if (crossDrop?.kind === 'questioner-reverse') {
          const tail = ulid().slice(-6).toLowerCase()
          request = {
            kind: 'cross-questioner',
            questionerNodeId: crossDrop.questionerNodeId,
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
            edgeIds: {
              ask: `cross_clarify_${tail}_ask`,
              answer: `cross_clarify_${tail}_ans`,
            },
          }
        } else if (crossDrop?.kind === 'designer-forward') {
          const tail = ulid().slice(-6).toLowerCase()
          request = {
            kind: 'cross-designer',
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
            designerNodeId: crossDrop.designerNodeId,
            edgeId: `cross_clarify_${tail}_designer`,
          }
        } else {
          // RFC-007/RFC-106: preserve exact NEW/REUSE geometric resolution;
          // only the graph application moves into the shared planner.
          let translated = translateInboundConnection(conn)
          let mode: 'new' | 'reuse' = conn.targetHandle === INBOUND_HANDLE_ID ? 'new' : 'reuse'
          const targetNode =
            conn.targetHandle === INBOUND_HANDLE_ID
              ? definition.nodes.find((node) => node.id === conn.target)
              : undefined
          if (
            targetNode !== undefined &&
            (targetNode.kind === 'agent-single' || targetNode.kind === 'output') &&
            conn.source != null &&
            conn.sourceHandle != null
          ) {
            let portName = nextFreeInputPort(
              existingInputPorts(definition, targetNode),
              conn.sourceHandle,
            )
            if (connectPointer.current !== null) {
              const screenPoint = connectPointer.current
              const resolved = resolveDropTarget(
                definition,
                getNodeBoxes(rf),
                rf.screenToFlowPosition(screenPoint),
                screenPoint,
                conn.source,
                conn.sourceHandle,
              )
              if (
                resolved !== null &&
                resolved.nodeId === conn.target &&
                resolved.kind === 'reuse'
              ) {
                portName = resolved.portName
                mode = 'reuse'
              }
            }
            translated = { ...conn, targetHandle: portName }
          }
          const translatedTarget = definition.nodes.find((node) => node.id === translated.target)
          request = {
            kind: 'generic',
            edgeId: `edge_${ulid().slice(-6).toLowerCase()}`,
            source: {
              nodeId: translated.source ?? '',
              portName: translated.sourceHandle ?? '',
            },
            targetNodeId: translated.target ?? '',
            target: {
              mode,
              portName: translated.targetHandle ?? '',
            },
            ...(translatedTarget?.kind === 'wrapper-fanout' && mode === 'new'
              ? { legacyFanoutInputInference: true }
              : {}),
          }
        }
      }
      const plan = planWorkflowConnection(definition, request, semanticContext)
      if (!plan.ok) return
      commitTransition({ kind: 'connection', plan }, { label: t('editor.history.connect') })
    },
    [commitTransition, definition, onChange, readOnly, rf, semanticContext, t],
  )

  // RFC-106: a fresh drag starts un-handled; onConnect flips the flag when it
  // snaps to a real handle. Track the pointer for the whole drag (see
  // connectPointer).
  const handleConnectStart = useCallback(() => {
    connectHandledRef.current = false
    connectPointer.current = null
    document.addEventListener('pointermove', trackConnectPointer)
  }, [trackConnectPointer])

  // RFC-106: body-drop fallback. When the drag ends over a node BODY (not near
  // any handle), xyflow never fires onConnect — so we resolve the drop pointer
  // against node bounds ourselves and add a NEW input (or REUSE an existing one),
  // matching the live ConnectDropHint preview. Handle drops (catch-all, channel
  // ports) are already handled by onConnect, guarded by connectHandledRef.
  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connState) => {
      document.removeEventListener('pointermove', trackConnectPointer)
      // Drop the tracked pointer so it can't leak into the NEXT gesture. ReactFlow's
      // click-to-connect never fires onConnectStart, so a stale point from a prior
      // drag could otherwise push a later catch-all CLICK into the reuse branch and
      // rebind an existing input instead of adding a new one (Codex P2). onConnect
      // for THIS drag already ran (and consumed connectPointer) before this fires.
      connectPointer.current = null
      if (readOnly === true || onChange === undefined) return
      if (connectHandledRef.current) {
        connectHandledRef.current = false
        return
      }
      // Only a drag that STARTED from a SOURCE (output) handle creates an input
      // edge. xyflow lets a reverse drag start from a TARGET/input handle, and
      // `fromHandle` is just where it started — treating that input as the edge
      // source would persist an invalid `C.requirement →` / `C.__inbound__ →`
      // edge (Codex P2). Those gestures are owned by onConnect's normalization.
      if (connState.fromHandle?.type !== 'source') return
      const src = connState.fromNode?.id
      const srcH = connState.fromHandle?.id
      if (src == null || srcH == null) return
      const p = 'changedTouches' in event ? event.changedTouches[0] : event
      if (p == null) return
      const screenPt = { x: p.clientX, y: p.clientY }
      const flowPt = rf.screenToFlowPosition(screenPt)
      const target = resolveDropTarget(definition, getNodeBoxes(rf), flowPt, screenPt, src, srcH)
      if (target === null) return
      const targetNode = definition.nodes.find((node) => node.id === target.nodeId)
      const plan = planWorkflowConnection(
        definition,
        {
          kind: 'generic',
          edgeId: `edge_${ulid().slice(-6).toLowerCase()}`,
          source: { nodeId: src, portName: srcH },
          targetNodeId: target.nodeId,
          target: { mode: target.kind, portName: target.portName },
          ...(targetNode?.kind === 'wrapper-fanout' && target.kind === 'new'
            ? { legacyFanoutInputInference: true }
            : {}),
        },
        semanticContext,
      )
      if (!plan.ok) return
      commitTransition({ kind: 'connection', plan }, { label: t('editor.history.connect') })
    },
    [commitTransition, definition, onChange, readOnly, rf, semanticContext, t, trackConnectPointer],
  )

  // RFC-106: inject (or clear) the live preview input port on the hovered node.
  // ConnectDropHint resolves the target during the drag and calls this; the
  // canvas owns `nodes` state so the mutation goes through setNodes (NOT the
  // definition — `previewInputPort` is transient UI state, never persisted).
  // Reference-stable when nothing changes so a redundant call is a no-op.
  const handlePreviewChange = useCallback((target: ConnectPreviewTarget | null) => {
    setNodes((prev) => {
      let changed = false
      const next = prev.map((n) => {
        const onThis = target !== null && target.nodeId === n.id
        const wantPreview = onThis && target.kind === 'new' ? target.port : undefined
        const wantReuse = onThis && target.kind === 'reuse' ? target.port : undefined
        const data = n.data as CanvasNodeData
        if (data.previewInputPort === wantPreview && data.reuseInputPort === wantReuse) return n
        changed = true
        return {
          ...n,
          data: { ...n.data, previewInputPort: wantPreview, reuseInputPort: wantReuse },
        }
      })
      return changed ? next : prev
    })
  }, [])

  // RFC-106: custom connection line. When the drag is over a node that will get
  // a NEW input (or REUSE an existing one), end the line exactly on that resolved
  // port's handle (queried from the DOM — ConnectDropHint already injected the
  // preview port / highlighted the reused one) instead of leaving it floating at
  // the pointer, so the in-flight line === the released edge. Falls back to a
  // plain bezier to the pointer otherwise (channels, empty canvas), matching
  // xyflow's default line.
  const ConnectionLine = useMemo(() => {
    function PreviewConnectionLine({
      fromX,
      fromY,
      fromPosition,
      toX,
      toY,
      toPosition,
      fromNode,
      fromHandle,
    }: ConnectionLineComponentProps) {
      let endX = toX
      let endY = toY
      let endPosition = toPosition
      // Only anchor the line to a resolved port for SOURCE-handle drags — a
      // reverse drag from a target handle isn't honored on release (Codex P2),
      // so it keeps the default bezier-to-pointer.
      if (fromNode != null && fromHandle?.id != null && fromHandle.type === 'source') {
        // toX/toY are already FLOW coords: the connection-line component reads
        // `to` from useConnection(), whose selector converts it via
        // pointToRendererPoint(to, transform) (@xyflow/react storeSelector$1), and
        // the line renders inside the transformed Viewport. So hit-test them
        // DIRECTLY — converting again would double-apply the transform and break
        // anchoring under pan/zoom. The CLIENT pointer is only the reuse probe
        // (`to` is snapped to the catch-all, so it can't be).
        const resolved = resolveDropTarget(
          definition,
          getNodeBoxes(rf),
          { x: toX, y: toY },
          connectPointer.current ?? rf.flowToScreenPosition({ x: toX, y: toY }),
          fromNode.id,
          fromHandle.id,
        )
        if (resolved !== null) {
          const el = document.querySelector(
            `.react-flow__node[data-id="${CSS.escape(resolved.nodeId)}"] .react-flow__handle[data-handleid="${CSS.escape(resolved.portName)}"]`,
          )
          if (el !== null) {
            const r = el.getBoundingClientRect()
            const fp = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
            endX = fp.x
            endY = fp.y
            endPosition = Position.Left
          }
        }
      }
      const [path] = getBezierPath({
        sourceX: fromX,
        sourceY: fromY,
        sourcePosition: fromPosition,
        targetX: endX,
        targetY: endY,
        targetPosition: endPosition,
      })
      return <path d={path} fill="none" className="react-flow__connection-path" />
    }
    return PreviewConnectionLine
  }, [definition, rf])

  /**
   * RFC-007 task-detail iterate lock. Editor canvas leaves taskContext
   * undefined → every connection is allowed (the lock is meaningful only
   * for live tasks). Read-only props on the task-detail canvas already
   * prevent connection attempts in practice; this is the belt-and-suspenders
   * guard for the case where read-only is bypassed and the user tries to
   * rewire a review whose iteration count is already non-zero.
   */
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const guardConn = {
        source: conn.source ?? null,
        target: conn.target ?? null,
        sourceHandle: conn.sourceHandle ?? null,
        targetHandle: conn.targetHandle ?? null,
      }
      let request: ConnectionRequest
      const clarifyDrop = classifyClarifyConnection(definition, guardConn)
      if (clarifyDrop !== null) {
        request = {
          kind: 'clarify-questioner',
          questionerNodeId: clarifyDrop.sourceAgentNodeId,
          clarifyNodeId: clarifyDrop.clarifyNodeId,
        }
      } else {
        const crossDrop = classifyCrossClarifyConnection(definition, guardConn)
        if (crossDrop?.kind === 'questioner-reverse') {
          request = {
            kind: 'cross-questioner',
            questionerNodeId: crossDrop.questionerNodeId,
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
          }
        } else if (crossDrop?.kind === 'designer-forward') {
          request = {
            kind: 'cross-designer',
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
            designerNodeId: crossDrop.designerNodeId,
          }
        } else {
          const translated = translateInboundConnection(guardConn)
          const mode = guardConn.targetHandle === INBOUND_HANDLE_ID ? 'new' : 'reuse'
          const targetNode = definition.nodes.find((node) => node.id === translated.target)
          const targetPortName =
            mode === 'new' &&
            targetNode !== undefined &&
            (targetNode.kind === 'agent-single' || targetNode.kind === 'output') &&
            translated.sourceHandle != null
              ? nextFreeInputPort(
                  existingInputPorts(definition, targetNode),
                  translated.sourceHandle,
                )
              : (translated.targetHandle ?? '')
          request = {
            kind: 'generic',
            source: {
              nodeId: translated.source ?? '',
              portName: translated.sourceHandle ?? '',
            },
            targetNodeId: translated.target ?? '',
            target: { mode, portName: targetPortName },
            ...(targetNode?.kind === 'wrapper-fanout' && mode === 'new'
              ? { legacyFanoutInputInference: true }
              : {}),
          }
        }
      }
      if (!planWorkflowConnection(definition, request, semanticContext).ok) return false
      // RFC-007 task-detail iterate lock.
      if (taskContext === undefined) return true
      if (conn.target === null || conn.target === undefined) return true
      const node = definition.nodes.find((n) => n.id === conn.target)
      if (node === undefined || node.kind !== 'review') return true
      const iter = taskContext.reviewIteration[conn.target] ?? 0
      return iter === 0
    },
    [definition, semanticContext, taskContext],
  )

  // ---- Clipboard / shortcuts (P-2-07) ----

  const copySelection = useCallback(() => {
    if (selection.nodes.length === 0) return
    try {
      const slice = buildSlice(definition, selection.nodes, workflowId ?? 'local-workflow')
      if (slice === null) return
      setClipboard(slice)
      setCanvasNotice(
        slice.warnings.length > 0
          ? t('canvas.clipboardReferencesFiltered', { n: slice.warnings.length })
          : null,
      )
    } catch {
      setCanvasNotice(t('canvas.clipboardBlocked'))
    }
  }, [definition, selection.nodes, t, workflowId])

  const pasteFromClipboard = useCallback(
    (at: { x: number; y: number }) => {
      const slice = getClipboard()
      if (slice === null || onChange === undefined || readOnly === true) return
      try {
        const { definition: next, newNodeIds, warnings } = applyPaste(definition, slice, at)
        const selectionBefore = singleCanvasSelection(selection.nodes, selection.edges)
        const accepted = commitChange(next, {
          label: t('editor.history.paste'),
          selectionBefore,
          // Multi-select has no single route inspector subject, but redo still
          // restores a useful focus target inside the newly-pasted slice.
          selectionAfter: newNodeIds[0] === undefined ? null : { kind: 'node', id: newNodeIds[0] },
        })
        if (!accepted) return
        syncCanvasSelection(newNodeIds, [])
        setCanvasNotice(
          warnings.length > 0
            ? t('canvas.clipboardReferencesFiltered', { n: warnings.length })
            : null,
        )
      } catch {
        setCanvasNotice(t('canvas.clipboardBlocked'))
      }
    },
    [
      commitChange,
      definition,
      onChange,
      readOnly,
      selection.edges,
      selection.nodes,
      syncCanvasSelection,
      t,
    ],
  )

  const selectAll = useCallback(() => {
    setSelection({
      nodes: definition.nodes.map((n) => n.id),
      edges: definition.edges.map((e) => e.id),
    })
  }, [definition])

  // Keyboard shortcuts — bound to the canvas wrapper to avoid hijacking
  // input fields elsewhere on the page.
  useEffect(() => {
    if (readOnly === true) return
    const el = wrapperRef.current
    if (el === null) return
    function onKey(e: KeyboardEvent) {
      if (isCanvasTextEditingTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        if (e.shiftKey) {
          if (canRedo === true) onRedo?.()
        } else if (canUndo === true) {
          onUndo?.()
        }
      } else if ((e.key === 'y' || e.key === 'Y') && e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        if (canRedo === true) onRedo?.()
      } else if (e.key === 'c' || e.key === 'C') {
        copySelection()
      } else if (e.key === 'v' || e.key === 'V') {
        // Paste in the visible viewport center so the user sees the result.
        const box = el!.getBoundingClientRect()
        const center = rf.screenToFlowPosition({
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        })
        pasteFromClipboard(center)
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        selectAll()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [canRedo, canUndo, copySelection, onRedo, onUndo, pasteFromClipboard, readOnly, rf, selectAll])

  const deleteSelected = useCallback(() => {
    if (onChange === undefined || readOnly === true) return
    if (selection.nodes.length === 0 && selection.edges.length === 0) return
    const accepted = commitTransition(
      {
        kind: 'delete-selection',
        nodeIds: selection.nodes,
        edgeIds: selection.edges,
      },
      {
        label: t('editor.history.delete'),
        selectionBefore: singleCanvasSelection(selection.nodes, selection.edges),
        selectionAfter: null,
      },
    )
    if (!accepted) return
    syncCanvasSelection([], [])
    wrapperRef.current?.focus()
  }, [
    commitTransition,
    onChange,
    readOnly,
    selection.edges,
    selection.nodes,
    syncCanvasSelection,
    t,
  ])

  const restoreRejectedFlowDelete = useCallback(
    (removedNodes: Node[], removedEdges: Edge[]) => {
      // xyflow projects keyboard deletion before `onDelete`; rebuild from the
      // unchanged canonical definition when the reference inventory rejects
      // the mutation. All setters run in this event callback, never inside a
      // replayable functional updater.
      const nodeIds = new Set(selectionRef.current.nodes)
      const edgeIds = new Set(selectionRef.current.edges)
      for (const node of removedNodes) if (node.selected === true) nodeIds.add(node.id)
      for (const edge of removedEdges) if (edge.selected === true) edgeIds.add(edge.id)
      const restoredSelection = { nodes: [...nodeIds], edges: [...edgeIds] }
      const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
      const restoredNodes = applySelection(
        projectDefinitionForXyflow(
          definition,
          toFlowNodes(
            definition,
            agentByName,
            nodeStatuses,
            questionCounts,
            handleQuestionBadgeClick,
            clarifyDirectives,
            handleClarifyDirectiveToggle,
            reviewNavs,
            clarifyNavs,
            readOnly !== true && onChange !== undefined ? handleAddInsideWrapper : undefined,
            undefined,
            surface,
          ),
          measured,
        ),
        restoredSelection.nodes,
      )
      const restoredEdges = applySelection(
        toFlowEdges(
          definition.edges,
          buildControlFlowEdgeIds(definition, agentByName),
          workflowInsertableEdgeIds(definition, semanticContext),
          {
            surface,
            readOnly,
            hasChangeHandler: onChange !== undefined,
            onInsertNode: handleInsertNodeOnEdge,
          },
        ),
        restoredSelection.edges,
      )
      nodesRef.current = restoredNodes
      edgesRef.current = restoredEdges
      setNodes(restoredNodes)
      setEdges(restoredEdges)
      syncCanvasSelection(restoredSelection.nodes, restoredSelection.edges)
      wrapperRef.current?.focus()
    },
    [
      agentByName,
      clarifyDirectives,
      clarifyNavs,
      definition,
      handleClarifyDirectiveToggle,
      handleAddInsideWrapper,
      handleQuestionBadgeClick,
      nodeStatuses,
      onChange,
      questionCounts,
      readOnly,
      reviewNavs,
      handleInsertNodeOnEdge,
      semanticContext,
      surface,
      syncCanvasSelection,
    ],
  )

  const handleFlowDelete = useCallback<OnDelete>(
    ({ nodes: removedNodes, edges: removedEdges }) => {
      if (onChange === undefined || readOnly === true) return
      const nodeIds = removedNodes.map((node) => node.id)
      const edgeIds = removedEdges.map((edge) => edge.id)
      const accepted = commitTransition(
        { kind: 'delete-selection', nodeIds, edgeIds },
        {
          label: t('editor.history.delete'),
          selectionBefore:
            nodeIds.length === 1
              ? { kind: 'node', id: nodeIds[0]! }
              : singleCanvasSelection([], edgeIds),
          selectionAfter: null,
        },
      )
      if (!accepted) {
        restoreRejectedFlowDelete(removedNodes, removedEdges)
        return
      }
      syncCanvasSelection([], [])
      // The selected DOM node may have been removed, causing focus to fall to
      // body. Return focus to the canvas so the immediately-following Undo is
      // reachable without an extra click.
      wrapperRef.current?.focus()
    },
    [commitTransition, onChange, readOnly, restoreRejectedFlowDelete, syncCanvasSelection, t],
  )

  const duplicateNode = useCallback(
    (nodeId: string) => {
      if (onChange === undefined || readOnly === true) return
      try {
        const slice = buildSlice(definition, [nodeId], workflowId ?? 'local-workflow')
        if (slice === null) return
        const at = { x: slice.anchor.x + 40, y: slice.anchor.y + 40 }
        const { definition: next, newNodeIds, warnings } = applyPaste(definition, slice, at)
        const accepted = commitChange(next, {
          label: t('editor.history.duplicate'),
          selectionBefore: { kind: 'node', id: nodeId },
          selectionAfter: newNodeIds[0] === undefined ? null : { kind: 'node', id: newNodeIds[0] },
        })
        if (!accepted) return
        syncCanvasSelection(newNodeIds, [])
        setCanvasNotice(
          warnings.length > 0
            ? t('canvas.clipboardReferencesFiltered', { n: warnings.length })
            : null,
        )
      } catch {
        setCanvasNotice(t('canvas.clipboardBlocked'))
      }
    },
    [commitChange, definition, onChange, readOnly, syncCanvasSelection, t, workflowId],
  )

  // P-3-04: wrap the current selection in a new wrapper-git / wrapper-loop
  // node. The wrapper's position is just behind the topmost-leftmost
  // selected node so it visually overlaps the group it owns.
  const wrapSelection = useCallback(
    (kind: 'wrapper-git' | 'wrapper-loop') => {
      if (onChange === undefined || readOnly === true) return
      const inner = selection.nodes
      if (inner.length === 0) return
      const innerSet = new Set(inner)
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      for (const [index, n] of definition.nodes.entries()) {
        if (!innerSet.has(n.id)) continue
        const p = effectiveWorkflowNodePosition(n, index)
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
      }
      if (!Number.isFinite(minX)) minX = 0
      if (!Number.isFinite(minY)) minY = 0
      const wrapperId = `${kind.replace('wrapper-', 'wrap_')}_${ulid().slice(-6).toLowerCase()}`
      const base = {
        id: wrapperId,
        kind,
        position: { x: Math.round(minX - 30), y: Math.round(minY - 30) },
        nodeIds: inner,
      }
      const wrapper =
        kind === 'wrapper-loop'
          ? { ...base, maxIterations: 3, exitCondition: { kind: 'port-empty' } }
          : base
      const selectionBefore = singleCanvasSelection(selection.nodes, selection.edges)
      const selectionAfter = { kind: 'node' as const, id: wrapperId }
      const accepted = commitChange(
        {
          ...definition,
          nodes: [...definition.nodes, wrapper as WorkflowNode],
        },
        {
          label: t('editor.history.wrap'),
          selectionBefore,
          selectionAfter,
        },
      )
      if (!accepted) return
      syncCanvasSelection([wrapperId], [])
    },
    [
      commitChange,
      definition,
      onChange,
      readOnly,
      selection.edges,
      selection.nodes,
      syncCanvasSelection,
      t,
    ],
  )

  const decomposeWrapper = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const node = definition.nodes.find((n) => n.id === wrapperId)
      if (node === undefined) return
      if (!isWrapperKind(node.kind)) return
      const inner = (node as Record<string, unknown>).nodeIds
      const innerIds = Array.isArray(inner)
        ? inner.filter((s): s is string => typeof s === 'string')
        : []
      const accepted = commitChange(
        {
          ...definition,
          nodes: definition.nodes.filter((n) => n.id !== wrapperId),
        },
        {
          label: t('editor.history.unwrap'),
          selectionBefore: { kind: 'node', id: wrapperId },
          selectionAfter: innerIds[0] === undefined ? null : { kind: 'node', id: innerIds[0] },
        },
      )
      if (accepted) syncCanvasSelection(innerIds, [])
    },
    [commitChange, definition, onChange, readOnly, syncCanvasSelection, t],
  )

  // RFC-016 T8: Fit to children — closure around the pure clearWrapperSize
  // transformation. The next onNodeDragStop / commitChange cycle writes the
  // recomputed bbox back to wrapper.size.
  const fitWrapperToChildren = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const next = clearWrapperSize(definition, wrapperId)
      if (next !== definition) {
        commitChange(next, {
          label: t('editor.history.fitWrapper'),
          selectionBefore: { kind: 'node', id: wrapperId },
          selectionAfter: { kind: 'node', id: wrapperId },
        })
      }
    },
    [commitChange, definition, onChange, readOnly, t],
  )

  // RFC-016 T8: delete a wrapper AND its inner nodes (right-click menu).
  // Differs from `Unwrap` (decomposeWrapper) which only removes the wrapper
  // and keeps the inner nodes on the canvas. Caller is responsible for the
  // user-facing confirm dialog.
  const deleteWrapperWithInner = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const accepted = commitTransition(
        { kind: 'delete-selection', nodeIds: [wrapperId], edgeIds: [] },
        {
          label: t('editor.history.delete'),
          selectionBefore: { kind: 'node', id: wrapperId },
          selectionAfter: null,
        },
      )
      if (!accepted) throw new Error(t('canvas.referenceChangeBlocked'))
      syncCanvasSelection([], [])
      wrapperRef.current?.focus()
    },
    [commitTransition, onChange, readOnly, syncCanvasSelection, t],
  )

  // One construction path for both desktop HTML5 drop and the accessible
  // palette activation path. Click / keyboard insertion additionally selects
  // the fresh node and opens its inspector; drag-and-drop keeps its existing
  // desktop behavior.
  const insertPaletteItem = useCallback(
    (
      item: PaletteItem,
      position: { x: number; y: number },
      selectAfterInsert: boolean,
      scope: { kind: 'top-level' } | { kind: 'wrapper'; wrapperNodeId: string } = {
        kind: 'top-level',
      },
    ) => {
      if (onChange === undefined || readOnly === true) return
      // RFC-223 PR7: all palette entry points converge here. Refuse an
      // untrusted or imperative name-only agent item before it can mint a
      // persisted workflow node.
      if (!hasCanonicalPaletteIdentity(item)) return
      const existingIds = new Set(definition.nodes.map((n) => n.id))
      const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
      const wrappers = resolveWrappers(definition, measured)
      const parentMap = buildParentMap(wrappers)
      let openPosition: { x: number; y: number }
      try {
        openPosition = findOpenPlacement({
          desiredPoint: position,
          candidateSize: DEFAULT_NODE_SIZE_BY_KIND[item.kind],
          scope,
          nodes: definition.nodes.map((node, index) => ({
            id: node.id,
            position: effectiveWorkflowNodePosition(node, index),
            measuredSize: measured.get(node.id),
            defaultSize: DEFAULT_NODE_SIZE_BY_KIND[node.kind],
            directWrapperNodeId: parentMap.get(node.id),
          })),
          wrapperRects: [...wrappers.values()].map((wrapper) => ({
            id: wrapper.id,
            x: wrapper.position.x,
            y: wrapper.position.y,
            width: wrapper.width,
            height: wrapper.height,
            directWrapperNodeId: parentMap.get(wrapper.id),
          })),
        })
      } catch {
        setCanvasNotice(t('canvas.placementUnavailable'))
        return
      }
      const newNode = makeNode(item, openPosition, { agents, existingIds })
      const nodesWithMembership = [...definition.nodes, newNode].map((node) => {
        if (scope.kind !== 'wrapper' || node.id !== scope.wrapperNodeId) return node
        const current = node as Record<string, unknown>
        const nodeIds = Array.isArray(current.nodeIds)
          ? current.nodeIds.filter((value): value is string => typeof value === 'string')
          : []
        return {
          ...current,
          nodeIds: nodeIds.includes(newNode.id) ? nodeIds : [...nodeIds, newNode.id],
        } as unknown as WorkflowNode
      })
      const accepted = commitChange(
        { ...definition, nodes: nodesWithMembership },
        {
          label: t('editor.history.insert'),
          selectionBefore: singleCanvasSelection(selection.nodes, selection.edges),
          selectionAfter: { kind: 'node', id: newNode.id },
        },
      )
      if (!accepted) return
      if (selectAfterInsert) syncCanvasSelection([newNode.id], [])
    },
    [
      agents,
      commitChange,
      definition,
      onChange,
      readOnly,
      selection.edges,
      selection.nodes,
      syncCanvasSelection,
      t,
    ],
  )

  const addPaletteItemAtViewportCenter = useCallback(
    (item: PaletteItem) => {
      const box = wrapperRef.current?.getBoundingClientRect()
      if (box === undefined) return
      insertPaletteItem(
        item,
        centerAnchoredTopLeft(
          rf.screenToFlowPosition(viewportCenter(box)),
          DEFAULT_NODE_SIZE_BY_KIND[item.kind],
        ),
        true,
      )
    },
    [insertPaletteItem, rf],
  )
  // Keep the public imperative handle stable for the existing clearSelection
  // contract while always dispatching to the latest definition / callbacks.
  const addPaletteItemAtViewportCenterRef = useRef(addPaletteItemAtViewportCenter)
  addPaletteItemAtViewportCenterRef.current = addPaletteItemAtViewportCenter
  const openNodePicker = useCallback(
    (intent?: WorkflowNodePickerIntent, trigger?: HTMLElement | null) => {
      if (readOnly === true || onChange === undefined) return
      nodePickerTriggerRef.current = trigger ?? wrapperRef.current
      onModalSurfaceChange?.('palette')
      if (intent !== undefined) {
        setNodePickerIntent(intent)
        return
      }
      const box = wrapperRef.current?.getBoundingClientRect()
      if (box === undefined) return
      setNodePickerIntent({
        kind: 'free',
        viewportPoint: rf.screenToFlowPosition(viewportCenter(box)),
        scope: { kind: 'top-level' },
      })
    },
    [onChange, onModalSurfaceChange, readOnly, rf],
  )
  openNodePickerRef.current = openNodePicker

  const makeEdgeInsertionCandidate = useCallback(
    (item: PaletteItem, edgeId: string, avoidCollisions: boolean): WorkflowNode | null => {
      if (!hasCanonicalPaletteIdentity(item)) return null
      const edge = definition.edges.find((candidate) => candidate.id === edgeId)
      if (edge === undefined) return null
      const sourceIndex = definition.nodes.findIndex((node) => node.id === edge.source.nodeId)
      const targetIndex = definition.nodes.findIndex((node) => node.id === edge.target.nodeId)
      if (sourceIndex < 0 || targetIndex < 0) return null
      const sourcePosition = effectiveWorkflowNodePosition(
        definition.nodes[sourceIndex]!,
        sourceIndex,
      )
      const targetPosition = effectiveWorkflowNodePosition(
        definition.nodes[targetIndex]!,
        targetIndex,
      )
      const desiredPoint = {
        x: Math.round((sourcePosition.x + targetPosition.x) / 2),
        y: Math.round((sourcePosition.y + targetPosition.y) / 2),
      }
      let position = desiredPoint
      if (avoidCollisions) {
        const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
        const wrappers = resolveWrappers(definition, measured)
        const parentMap = buildParentMap(wrappers)
        try {
          position = findOpenPlacement({
            desiredPoint,
            candidateSize: DEFAULT_NODE_SIZE_BY_KIND[item.kind],
            scope: { kind: 'top-level' },
            nodes: definition.nodes.map((node, index) => ({
              id: node.id,
              position: effectiveWorkflowNodePosition(node, index),
              measuredSize: measured.get(node.id),
              defaultSize: DEFAULT_NODE_SIZE_BY_KIND[node.kind],
              directWrapperNodeId: parentMap.get(node.id),
            })),
            wrapperRects: [...wrappers.values()].map((wrapper) => ({
              id: wrapper.id,
              x: wrapper.position.x,
              y: wrapper.position.y,
              width: wrapper.width,
              height: wrapper.height,
              directWrapperNodeId: parentMap.get(wrapper.id),
            })),
          })
        } catch {
          return null
        }
      }
      return makeNode(item, position, {
        agents,
        existingIds: new Set(definition.nodes.map((node) => node.id)),
      })
    },
    [agents, definition],
  )

  const nodePickerDisabledReason = useCallback(
    (item: PaletteItem): string | null => {
      if (nodePickerIntent?.kind !== 'insert-edge') return null
      const candidate = makeEdgeInsertionCandidate(item, nodePickerIntent.edgeId, false)
      if (candidate === null) return t('canvas.placementUnavailable')
      const plan = planWorkflowEdgeInsertion(
        definition,
        nodePickerIntent.edgeId,
        candidate,
        semanticContext,
      )
      return plan.ok ? null : plan.reason.message
    },
    [definition, makeEdgeInsertionCandidate, nodePickerIntent, semanticContext, t],
  )

  const pickNode = useCallback(
    (item: PaletteItem) => {
      const intent = nodePickerIntent
      if (intent === null) return
      if (intent.kind === 'free') {
        insertPaletteItem(
          item,
          centerAnchoredTopLeft(intent.viewportPoint, DEFAULT_NODE_SIZE_BY_KIND[item.kind]),
          true,
          intent.scope,
        )
      } else if (intent.kind === 'after-node') {
        const sourceIndex = definition.nodes.findIndex((node) => node.id === intent.nodeId)
        if (sourceIndex >= 0) {
          const source = definition.nodes[sourceIndex]!
          const position = effectiveWorkflowNodePosition(source, sourceIndex)
          insertPaletteItem(
            item,
            {
              x: position.x + DEFAULT_NODE_SIZE_BY_KIND[source.kind].width + 80,
              y: position.y,
            },
            true,
            intent.scope,
          )
        }
      } else if (intent.kind === 'inside-wrapper') {
        const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
        const wrapper = resolveWrappers(definition, measured).get(intent.wrapperNodeId)
        if (wrapper !== undefined) {
          insertPaletteItem(
            item,
            { x: wrapper.position.x + 40, y: wrapper.position.y + 64 },
            true,
            { kind: 'wrapper', wrapperNodeId: intent.wrapperNodeId },
          )
        }
      } else if (intent.kind === 'insert-edge') {
        const candidate = makeEdgeInsertionCandidate(item, intent.edgeId, true)
        if (candidate === null) {
          setCanvasNotice(t('canvas.placementUnavailable'))
          return
        }
        const plan = planWorkflowEdgeInsertion(
          definition,
          intent.edgeId,
          candidate,
          semanticContext,
        )
        if (!plan.ok) {
          setCanvasNotice(plan.reason.message)
          return
        }
        const accepted = commitTransition(
          { kind: 'connection', plan },
          {
            label: t('editor.history.insert'),
            selectionBefore: { kind: 'edge', id: intent.edgeId },
            selectionAfter: { kind: 'node', id: candidate.id },
          },
        )
        if (!accepted) return
        syncCanvasSelection([candidate.id], [])
        announceCanvasChange(
          t('editor.connectionDialog.inserted', { node: candidate.id, edge: intent.edgeId }),
        )
      }
      setNodePickerIntent(null)
      onModalSurfaceChange?.(null)
    },
    [
      commitTransition,
      definition,
      insertPaletteItem,
      makeEdgeInsertionCandidate,
      nodePickerIntent,
      onModalSurfaceChange,
      semanticContext,
      syncCanvasSelection,
      t,
      announceCanvasChange,
    ],
  )

  const selectedNodeId = selection.nodes.length === 1 ? selection.nodes[0]! : null
  const selectedNode =
    selectedNodeId === null
      ? undefined
      : definition.nodes.find((node) => node.id === selectedNodeId)
  const selectedNodeCanConnect =
    selectedNode !== undefined &&
    computePorts(selectedNode, agentByName, definition).outputs.length > 0

  const openConnectionDialog = useCallback(
    (nodeId: string, trigger: HTMLElement | null) => {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId)
      if (node === undefined || computePorts(node, agentByName, definition).outputs.length === 0) {
        return
      }
      connectionTriggerRef.current = trigger
      setConnectionReplaceEdgeId(null)
      setConnectionSourceNodeId(nodeId)
      setMenu(null)
      onModalSurfaceChange?.('connection')
    },
    [agentByName, definition, onModalSurfaceChange],
  )

  const openAfterNodePicker = useCallback(
    (nodeId: string, trigger: HTMLElement) => {
      const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
      const parent = buildParentMap(resolveWrappers(definition, measured)).get(nodeId)
      openNodePicker(
        {
          kind: 'after-node',
          nodeId,
          scope:
            parent === undefined
              ? { kind: 'top-level' }
              : { kind: 'wrapper', wrapperNodeId: parent },
        },
        trigger,
      )
    },
    [definition, openNodePicker],
  )

  const openNodeMenu = useCallback((nodeId: string, trigger: HTMLElement) => {
    const canvasRect = wrapperRef.current?.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    menuTriggerRef.current = trigger
    setMenu({
      x: canvasRect === undefined ? triggerRect.left : triggerRect.left - canvasRect.left,
      y: canvasRect === undefined ? triggerRect.bottom : triggerRect.bottom - canvasRect.top + 4,
      nodeId,
    })
  }, [])

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly === true) return
    if (
      e.dataTransfer.types.includes(PALETTE_MIME) ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly === true) return
    if (onChange === undefined) return
    const raw = e.dataTransfer.getData(PALETTE_MIME) || e.dataTransfer.getData('text/plain')
    if (raw === '') return
    const item = deserialize(raw)
    if (item === null) return
    e.preventDefault()
    // The cursor is where the user aimed — center the node there instead of
    // hanging the whole rect off the cursor's bottom-right.
    insertPaletteItem(
      item,
      centerAnchoredTopLeft(
        rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        DEFAULT_NODE_SIZE_BY_KIND[item.kind],
      ),
      false,
    )
  }

  function handleNodeContextMenu(e: React.MouseEvent, node: Node) {
    if (readOnly === true) return
    e.preventDefault()
    e.stopPropagation()
    const box = wrapperRef.current?.getBoundingClientRect()
    const x = box === undefined ? e.clientX : e.clientX - box.left
    const y = box === undefined ? e.clientY : e.clientY - box.top
    menuTriggerRef.current = e.currentTarget as HTMLElement
    setMenu({ x, y, nodeId: node.id })
    // Make sure the right-clicked node is part of the selection.
    if (!selection.nodes.includes(node.id)) {
      setSelection({ nodes: [node.id], edges: [] })
    }
  }

  function handlePaneContextMenu(e: MouseEvent | React.MouseEvent) {
    if (readOnly === true) return
    e.preventDefault()
    const box = wrapperRef.current?.getBoundingClientRect()
    const x = box === undefined ? e.clientX : e.clientX - box.left
    const y = box === undefined ? e.clientY : e.clientY - box.top
    menuTriggerRef.current = wrapperRef.current
    setMenu({ x, y, nodeId: null })
  }

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (menu === null) return []
    if (menu.nodeId === null) {
      // Pane menu — paste / select-all.
      return [
        {
          label: t('editor.menuPaste'),
          disabled: getClipboard() === null,
          onSelect: () => {
            if (wrapperRef.current === null) return
            const box = wrapperRef.current.getBoundingClientRect()
            pasteFromClipboard(
              rf.screenToFlowPosition({ x: box.left + menu.x, y: box.top + menu.y }),
            )
          },
        },
        { label: t('editor.menuSelectAll'), onSelect: selectAll },
      ]
    }
    const menuNode = definition.nodes.find((candidate) => candidate.id === menu.nodeId)
    const menuNodeCanConnect =
      menuNode !== undefined && computePorts(menuNode, agentByName, definition).outputs.length > 0
    return [
      {
        label: t('editor.nodeActions.connectNext'),
        disabled: !menuNodeCanConnect,
        onSelect: () => openConnectionDialog(menu.nodeId!, menuTriggerRef.current),
      },
      {
        label: t('editor.menuDuplicate'),
        onSelect: () => menu.nodeId !== null && duplicateNode(menu.nodeId),
      },
      {
        label: t('editor.menuCopy'),
        onSelect: copySelection,
        disabled: selection.nodes.length === 0,
      },
      {
        label: t('editor.menuWrapGit'),
        disabled: selection.nodes.length === 0,
        onSelect: () => wrapSelection('wrapper-git'),
      },
      // wrapper-loop is M4 territory; we still expose it so users can
      // pre-author workflows but the scheduler will reject runs.
      {
        label: t('editor.menuWrapLoop'),
        disabled: selection.nodes.length === 0,
        onSelect: () => wrapSelection('wrapper-loop'),
      },
      {
        // RFC-016 T8: rename "Decompose" → "Unwrap" in the user-facing
        // string; the underlying decomposeWrapper logic is unchanged.
        label: t('wrapperNode.unwrap'),
        disabled: !isWrapperNode(definition, menu.nodeId),
        onSelect: () => menu.nodeId !== null && decomposeWrapper(menu.nodeId),
      },
      {
        // RFC-016 T8: Fit to children — clears wrapper.size so the next
        // render recomputes from the current inner-node bbox.
        label: t('wrapperNode.fitToChildren'),
        disabled: !isWrapperNode(definition, menu.nodeId),
        onSelect: () => menu.nodeId !== null && fitWrapperToChildren(menu.nodeId),
      },
      {
        // RFC-016 T8: explicit "delete the wrapper AND every inner node",
        // distinct from Unwrap which keeps inner nodes on the canvas.
        label: t('wrapperNode.deleteWithInner'),
        danger: true,
        disabled: !isWrapperNode(definition, menu.nodeId),
        onSelect: () => {
          if (menu.nodeId === null) return
          const snapshot = snapshotWrapperDelete(definition, menu.nodeId)
          if (snapshot !== null) {
            setWrapperDeleteSnapshot(snapshot)
            onModalSurfaceChange?.('confirm')
          }
        },
      },
      { label: t('common.delete'), danger: true, onSelect: deleteSelected },
    ]
  }, [
    agentByName,
    copySelection,
    decomposeWrapper,
    definition,
    deleteSelected,
    duplicateNode,
    fitWrapperToChildren,
    menu,
    onModalSurfaceChange,
    openConnectionDialog,
    pasteFromClipboard,
    rf,
    selectAll,
    selection.nodes.length,
    t,
    wrapSelection,
  ])

  useEffect(() => {
    if (readOnly === true) return
    const element = wrapperRef.current
    if (element === null) return
    const openKeyboardMenu = (event: KeyboardEvent) => {
      if (isCanvasTextEditingTarget(event.target)) return
      if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
      const nodeId =
        selectionRef.current.nodes.length === 1 ? selectionRef.current.nodes[0] : undefined
      if (nodeId === undefined) return
      const nodeElement = [...element.querySelectorAll<HTMLElement>('.react-flow__node')].find(
        (candidate) => candidate.dataset.id === nodeId,
      )
      if (nodeElement === undefined) return
      event.preventDefault()
      openNodeMenu(nodeId, nodeElement)
    }
    element.addEventListener('keydown', openKeyboardMenu)
    return () => element.removeEventListener('keydown', openKeyboardMenu)
  }, [openNodeMenu, readOnly])

  // Lets the parent route deselect the canvas from outside — required by
  // the EdgeInspector / NodeInspector ✕ buttons. Just nulling the parent's
  // selection state leaves xyflow's edge.selected/node.selected true AND
  // pins `lastEmittedSelectionSig`, so the dedupe in `onEdgeClick` swallows
  // the next click on the same edge AND the next click on the same node
  // (xyflow's `handleNodeClick` no-ops when `nodeLookup[id].selected` is
  // still true and multi-select isn't active). Drive xyflow's canonical
  // `unselectNodesAndEdges` action so internal `nodeLookup` and the React
  // `nodes`/`edges` state stay in lock-step.
  useImperativeHandle(
    handleRef,
    () => ({
      addPaletteItemAtViewportCenter: (item) => {
        addPaletteItemAtViewportCenterRef.current(item)
      },
      openNodePicker: (intent, trigger) => {
        openNodePickerRef.current(intent, trigger)
      },
      openConnection: (nodeId, trigger) => {
        openConnectionDialog(nodeId, trigger ?? null)
      },
      openEdgeReconnect: (edgeId, trigger) => {
        const edge = definition.edges.find((candidate) => candidate.id === edgeId)
        if (edge === undefined) return
        connectionTriggerRef.current = trigger ?? null
        setConnectionReplaceEdgeId(edgeId)
        setConnectionSourceNodeId(edge.source.nodeId)
        onModalSurfaceChange?.('connection')
      },
      closeModalSurface: () => {
        setNodePickerIntent(null)
        setConnectionSourceNodeId(null)
        setConnectionReplaceEdgeId(null)
        setWrapperDeleteSnapshot(null)
        onModalSurfaceChange?.(null)
      },
      clearSelection: () => {
        storeApi.getState().unselectNodesAndEdges()
        setSelection((prev) =>
          prev.nodes.length === 0 && prev.edges.length === 0 ? prev : { nodes: [], edges: [] },
        )
        lastEmittedSelectionSig.current = 'null'
      },
      restoreSelection: (nextSelection) => {
        storeApi.getState().unselectNodesAndEdges()
        const selectedNodes = nextSelection?.kind === 'node' ? [nextSelection.id] : []
        const selectedEdges = nextSelection?.kind === 'edge' ? [nextSelection.id] : []
        setNodes((current) => applySelection(clearFlowSelection(current), selectedNodes))
        setEdges((current) => applySelection(clearFlowSelection(current), selectedEdges))
        setSelection({ nodes: selectedNodes, edges: selectedEdges })
        lastEmittedSelectionSig.current =
          nextSelection === null ? 'null' : `${nextSelection.kind}:${nextSelection.id}`
        wrapperRef.current?.focus()
      },
      focusSelection: (nextSelection) => {
        storeApi.getState().unselectNodesAndEdges()
        const selectedNodes = nextSelection.kind === 'node' ? [nextSelection.id] : []
        const selectedEdges = nextSelection.kind === 'edge' ? [nextSelection.id] : []
        setNodes((current) => applySelection(clearFlowSelection(current), selectedNodes))
        setEdges((current) => applySelection(clearFlowSelection(current), selectedEdges))
        setSelection({ nodes: selectedNodes, edges: selectedEdges })
        lastEmittedSelectionSig.current = `${nextSelection.kind}:${nextSelection.id}`
        window.requestAnimationFrame(() => {
          const nodeIds =
            nextSelection.kind === 'node'
              ? [nextSelection.id]
              : definition.edges
                  .filter((edge) => edge.id === nextSelection.id)
                  .flatMap((edge) => [edge.source.nodeId, edge.target.nodeId])
          const visibleNodes = nodeIds
            .map((id) => rf.getNode(id))
            .filter((node): node is NonNullable<typeof node> => node !== undefined)
          if (visibleNodes.length > 0) {
            void rf.fitView({ nodes: visibleNodes, padding: 0.5, maxZoom: 1.25, duration: 180 })
          }
        })
      },
    }),
    [definition.edges, onModalSurfaceChange, openConnectionDialog, rf, storeApi],
  )

  return (
    <div
      ref={wrapperRef}
      className="workflow-canvas"
      data-surface={surface}
      role="region"
      aria-label={t('canvas.accessibleName')}
      aria-describedby={canvasDescriptionId}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <p id={canvasDescriptionId} className="sr-only">
        {t('canvas.accessibleDescription')}
      </p>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onDelete={handleFlowDelete}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onSelectionChange={(s) => {
          const ns = s.nodes.map((n) => n.id)
          const es = s.edges.map((e) => e.id)
          // xyflow re-fires onSelectionChange after every node/edge update
          // even when the selected set is unchanged. Bail when nothing
          // actually changed so we don't loop on a fresh object reference.
          //
          // Keep internal selection state up to date so clipboard / Delete
          // shortcuts and the right-click context menu see the right thing.
          // We intentionally DO NOT emit onSelect here — xyflow flips a
          // node's `selected` flag at mousedown (before a drag has even
          // started), and emitting through this path would pop the
          // inspector open every time the user grabs a node to move it.
          // Open the inspector from explicit `onNodeClick` / `onEdgeClick`
          // / `onPaneClick` below instead; xyflow only fires those for
          // genuine clicks (no drag motion past the threshold).
          setSelection((prev) =>
            sameIds(prev.nodes, ns) && sameIds(prev.edges, es) ? prev : { nodes: ns, edges: es },
          )
        }}
        onNodeClick={(_, node) => {
          // Click-only path; xyflow does not fire this when the gesture
          // becomes a drag. Dedupe via lastEmittedSelectionSig so a second
          // click on the same node doesn't re-emit and re-render.
          const sig = `node:${node.id}`
          if (sig === lastEmittedSelectionSig.current) return
          lastEmittedSelectionSig.current = sig
          if (onSelect !== undefined) onSelect({ kind: 'node', id: node.id })
        }}
        onEdgeClick={(_, edge) => {
          // Explicit edge-selection emit. xyflow's onSelectionChange path
          // sometimes does not fire for plain edge clicks (selectionOnDrag
          // + panOnDrag interplay), so we wire onEdgeClick directly to
          // open the EdgeInspector. Dedupe via lastEmittedSelectionSig so
          // we don't loop when both this and onSelectionChange fire.
          const sig = `edge:${edge.id}`
          if (sig === lastEmittedSelectionSig.current) return
          lastEmittedSelectionSig.current = sig
          setSelection({ nodes: [], edges: [edge.id] })
          if (onSelect !== undefined) onSelect({ kind: 'edge', id: edge.id })
        }}
        onPaneClick={() => {
          // Clicking empty canvas dismisses any open inspector. Without
          // this the inspector stayed open after pane clicks because
          // onSelectionChange no longer drives onSelect.
          if (lastEmittedSelectionSig.current === 'null') return
          lastEmittedSelectionSig.current = 'null'
          if (onSelect !== undefined) onSelect(null)
        }}
        onNodeDragStop={(_evt, _node, draggedNodes) => {
          // Commit final positions once when the drag ends, instead of on
          // every position change. `affectsDefinition` excludes 'position'
          // for the same reason — see its docstring. We send the FULL
          // current `nodes`/`edges` snapshot (not just the dragged ones)
          // because toDefinition computes a complete next-state.
          if (readOnly === true || onChange === undefined) return
          if (draggedNodes.length === 0) return
          // RFC-016: with positions about to be committed, decide whether any
          // dragged node also changed wrapper membership (hit a new wrapper
          // rect or left its current one). The membership patches go through
          // applyMembershipPatch on the post-positions definition so the
          // wrapper.nodeIds list stays in lock-step with the visible layout.
          const measured = buildMeasuredSizesFromXyflowNodes(nodes)
          let nextDef = toDefinition(definition, nodes, edges, measured)
          const absoluteNodes = projectXyflowPositionsToAbsolute(definition, nodes, measured)
          const wrappers: WrapperHitInput[] = []
          for (const fn of nodes) {
            if (!isWrapperKind(fn.type)) continue
            const style = fn.style as { width?: unknown; height?: unknown } | undefined
            const w = typeof style?.width === 'number' ? style.width : 200
            const h = typeof style?.height === 'number' ? style.height : 120
            const absForRect = absoluteNodes.find((n) => n.id === fn.id)
            const px = absForRect?.position.x ?? fn.position.x
            const py = absForRect?.position.y ?? fn.position.y
            const rec = nextDef.nodes.find((n) => n.id === fn.id) as
              | (WorkflowNode & { nodeIds?: unknown })
              | undefined
            const ids = Array.isArray(rec?.nodeIds)
              ? (rec!.nodeIds as unknown[]).filter((s): s is string => typeof s === 'string')
              : []
            wrappers.push({
              id: fn.id,
              rect: { x: px, y: py, width: w, height: h },
              nodeIds: ids,
            })
          }
          for (const dn of draggedNodes) {
            // Wrapper-on-wrapper or non-wrapper-into-wrapper both go through
            // the same path. Wrapper-on-itself and cyclic drops onto a nested
            // descendant are excluded inside resolve().
            const absNode = absoluteNodes.find((n) => n.id === dn.id)
            if (absNode === undefined) continue
            const m = measured.get(dn.id)
            const fallback = (dn.type ?? 'agent-single') as keyof typeof DEFAULT_NODE_SIZE_BY_KIND
            const size = m ?? DEFAULT_NODE_SIZE_BY_KIND[fallback] ?? { width: 240, height: 120 }
            const center = {
              x: absNode.position.x + size.width / 2,
              y: absNode.position.y + size.height / 2,
            }
            const patch = resolveMembershipOnDragStop({
              draggedNodeId: dn.id,
              draggedCenter: center,
              wrappers,
              blockedWrapperIds: isWrapperKind(dn.type)
                ? wrapperDescendantIds(nextDef, dn.id)
                : undefined,
            })
            nextDef = applyMembershipPatch(nextDef, patch)
          }
          // Re-fit wrappers whose still-inner dragged child may now sit
          // too close OR too far from the wrapper border. We look up each
          // dragged node's post-patch parent wrapper in nextDef (so
          // wrappers the node *left* are correctly skipped —
          // applyMembershipPatch already dropped their persisted size and
          // the next render re-fits them from scratch). The fit helper is
          // bidirectional (grows if crowded, shrinks if overgrown) and is
          // a no-op when the wrapper has no persisted size, is sizeLocked,
          // or already matches the target clearance.
          const wrapperParentOf = new Map<string, string>()
          for (const wn of nextDef.nodes) {
            if (!isWrapperKind(wn.kind)) continue
            const innerIds = (wn as unknown as { nodeIds?: unknown }).nodeIds
            if (!Array.isArray(innerIds)) continue
            for (const id of innerIds) {
              if (typeof id === 'string') wrapperParentOf.set(id, wn.id)
            }
          }
          const toFit = new Set<string>()
          for (const dn of draggedNodes) {
            const wid = wrapperParentOf.get(dn.id)
            if (wid !== undefined) toFit.add(wid)
          }
          for (const wid of toFit) {
            nextDef = fitWrapperToInner(nextDef, wid, measured)
          }
          const primaryDragged = draggedNodes[0]?.id
          commitChange(nextDef, {
            label: t('editor.history.move'),
            selectionBefore:
              primaryDragged === undefined ? null : { kind: 'node', id: primaryDragged },
            selectionAfter:
              primaryDragged === undefined ? null : { kind: 'node', id: primaryDragged },
          })
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        nodesDraggable={readOnly !== true}
        edgesFocusable={readOnly !== true}
        nodesConnectable={readOnly !== true}
        deleteKeyCode={readOnly === true ? null : deleteKeyCodes}
        multiSelectionKeyCode={['Shift', 'Meta']}
        // Pan on middle / right button drag only. Left button is reserved
        // for click selection on nodes / edges (RFC-003 EdgeInspector
        // requires reachable edge clicks). Shift+drag lassos via xyflow
        // default `selectionKeyCode='Shift'`. We deliberately do NOT enable
        // `selectionOnDrag` — it intercepts every left click into a
        // zero-distance lasso and silently swallows edge clicks.
        panOnDrag={readOnly === true ? true : [1, 2]}
        fitView
        minZoom={0.2}
        maxZoom={2}
        // RFC-106 T2 — tighten the connection snap so the small named input
        // handles (7px dots) only capture a PRECISE drop; elsewhere over the
        // node's left edge the full-height catch-all (`__inbound__`) wins and
        // the drop becomes a new input. Default 20 was loose enough that the
        // dots "grabbed" most of the edge, causing accidental reuse.
        connectionRadius={10}
        connectionLineComponent={ConnectionLine}
        // RFC-106: drag-only wiring. With named input handles non-connectable, a
        // click-to-connect onto one would silently no-op (xyflow rejects the
        // click-end), and click-to-connect can't show the live drag preview
        // anyway. Disabling it keeps one consistent gesture — drag from an output
        // onto the target — with no silent dead-ends (Codex P2).
        connectOnClick={false}
      >
        <Background />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
        {readOnly !== true && onChange !== undefined ? (
          <Panel position="top-right" className="workflow-canvas__layout-panel">
            <div role="toolbar" aria-label={t('editor.layoutToolbar')}>
              <button
                type="button"
                className="btn btn--xs"
                data-testid="workflow-layout-all"
                disabled={definition.nodes.length < 2}
                onClick={() => handleAutoLayout({ mode: 'all' })}
              >
                {t('editor.layoutAll')}
              </button>
              <button
                type="button"
                className="btn btn--xs"
                data-testid="workflow-layout-selection"
                disabled={selection.nodes.length < 2}
                onClick={() =>
                  handleAutoLayout({ mode: 'selection', nodeIds: [...selection.nodes] })
                }
              >
                {t('editor.layoutSelection')}
              </button>
            </div>
          </Panel>
        ) : null}
        {readOnly !== true && onChange !== undefined && selectedNodeId !== null ? (
          <NodeToolbar
            nodeId={selectedNodeId}
            isVisible
            position={Position.Top}
            className="workflow-canvas__node-actions nodrag nowheel"
          >
            <button
              type="button"
              className="btn btn--xs"
              aria-label={t('editor.nodeActions.addNext')}
              onClick={(event) => openAfterNodePicker(selectedNodeId, event.currentTarget)}
            >
              +
            </button>
            <button
              type="button"
              className="btn btn--xs btn--primary"
              disabled={!selectedNodeCanConnect}
              onClick={(event) => openConnectionDialog(selectedNodeId, event.currentTarget)}
            >
              {t('editor.nodeActions.connectNext')}
            </button>
            <button type="button" className="btn btn--xs" onClick={copySelection}>
              {t('editor.nodeActions.copy')}
            </button>
            <button
              type="button"
              className="btn btn--xs"
              aria-label={t('editor.nodeActions.more')}
              onClick={(event) => openNodeMenu(selectedNodeId, event.currentTarget)}
            >
              ⋯
            </button>
          </NodeToolbar>
        ) : null}
        {readOnly !== true && (
          <ConnectDropHint
            definition={definition}
            labels={{
              newInput: t('canvas.connect.newInput'),
              reuseInput: t('canvas.connect.reuseInput'),
            }}
            pointerRef={connectPointer}
            onPreviewChange={handlePreviewChange}
          />
        )}
      </ReactFlow>
      {definition.nodes.length === 0 ? (
        <div className="workflow-canvas__empty" data-testid="workflow-canvas-empty">
          <EmptyState
            title={t('editor.emptyCanvas.title')}
            description={t('editor.emptyCanvas.description')}
            action={
              readOnly !== true && onChange !== undefined ? (
                <div className="workflow-canvas__empty-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    data-testid="workflow-empty-add-first"
                    onClick={(event) => openNodePicker(undefined, event.currentTarget)}
                  >
                    {t('editor.emptyCanvas.addFirst')}
                  </button>
                  {onStartFromTemplate !== undefined ? (
                    <button
                      type="button"
                      className="btn"
                      data-testid="workflow-empty-start-template"
                      onClick={(event) => onStartFromTemplate(event.currentTarget)}
                    >
                      {t('editor.emptyCanvas.startTemplate')}
                    </button>
                  ) : null}
                </div>
              ) : undefined
            }
            data-testid="workflow-canvas-empty-state"
          />
        </div>
      ) : null}
      {canvasNotice !== null ? (
        <NoticeBanner
          tone="warning"
          size="compact"
          className="workflow-canvas__clipboard-notice"
          action={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('common.close')}
              onClick={() => setCanvasNotice(null)}
            >
              ×
            </button>
          }
        >
          {canvasNotice}
        </NoticeBanner>
      ) : null}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        header={
          menu?.nodeId !== undefined && menu?.nodeId !== null ? (
            <code>{menu.nodeId}</code>
          ) : (
            <span>{t('editor.menuSelectedCount', { n: selection.nodes.length })}</span>
          )
        }
        triggerRef={menuTriggerRef}
      />
      <ConnectionDialog
        open={connectionSourceNodeId !== null}
        definition={definition}
        agents={agents ?? []}
        sourceNodeId={connectionSourceNodeId ?? ''}
        sourcePortName={
          connectionReplaceEdgeId === null
            ? undefined
            : definition.edges.find((edge) => edge.id === connectionReplaceEdgeId)?.source.portName
        }
        replaceEdgeId={connectionReplaceEdgeId ?? undefined}
        initialTargetNodeId={
          connectionReplaceEdgeId === null
            ? undefined
            : definition.edges.find((edge) => edge.id === connectionReplaceEdgeId)?.target.nodeId
        }
        initialTargetPortName={
          connectionReplaceEdgeId === null
            ? undefined
            : definition.edges.find((edge) => edge.id === connectionReplaceEdgeId)?.target.portName
        }
        triggerRef={connectionTriggerRef}
        restoreFocusFallbackRef={wrapperRef}
        onClose={() => {
          setConnectionSourceNodeId(null)
          setConnectionReplaceEdgeId(null)
          onModalSurfaceChange?.(null)
        }}
        onApply={(plan, targetNodeId) => {
          const sourceNodeId = connectionSourceNodeId
          if (sourceNodeId === null) return false
          const replacedEdgeId = connectionReplaceEdgeId
          const accepted = commitTransition(
            { kind: 'connection', plan },
            {
              label: t('editor.history.connect'),
              selectionBefore:
                replacedEdgeId === null
                  ? { kind: 'node', id: sourceNodeId }
                  : { kind: 'edge', id: replacedEdgeId },
              selectionAfter:
                replacedEdgeId === null
                  ? { kind: 'node', id: targetNodeId }
                  : { kind: 'edge', id: replacedEdgeId },
            },
          )
          if (!accepted) return false
          if (replacedEdgeId === null) syncCanvasSelection([targetNodeId], [])
          else syncCanvasSelection([], [replacedEdgeId])
          announceCanvasChange(
            t('editor.connectionDialog.applied', { source: sourceNodeId, target: targetNodeId }),
          )
          return true
        }}
      />
      {managedLiveRegion === null ? (
        <div className="workflow-canvas__live" aria-live="polite" aria-atomic="true">
          {connectionAnnouncement}
        </div>
      ) : null}
      <WorkflowNodePicker
        open={nodePickerIntent !== null}
        agents={agents ?? []}
        intent={
          nodePickerIntent ?? {
            kind: 'free',
            viewportPoint: { x: 0, y: 0 },
            scope: { kind: 'top-level' },
          }
        }
        onClose={() => {
          setNodePickerIntent(null)
          onModalSurfaceChange?.(null)
        }}
        onPick={pickNode}
        disabledReason={nodePickerDisabledReason}
        triggerRef={nodePickerTriggerRef}
        restoreFocusFallbackRef={wrapperRef}
      />
      <ConfirmDialog
        open={wrapperDeleteSnapshot !== null}
        title={t('wrapperNode.deleteWithInner')}
        description={t('wrapperNode.confirmDeleteWithInner', {
          count: wrapperDeleteSnapshot?.childIds.length ?? 0,
        })}
        confirmLabel={t('common.delete')}
        tone="danger"
        restoreFocusFallbackRef={wrapperRef}
        onClose={() => {
          setWrapperDeleteSnapshot(null)
          onModalSurfaceChange?.(null)
        }}
        onConfirm={() => {
          const snapshot = wrapperDeleteSnapshot
          if (snapshot === null) return
          if (!isWrapperDeleteSnapshotCurrent(definition, snapshot)) {
            throw new Error(t('wrapperNode.deleteScopeChanged'))
          }
          deleteWrapperWithInner(snapshot.wrapperId)
        }}
      />
      {readOnly !== true ? (
        <div className="workflow-canvas__hint-bottom" aria-hidden="true">
          {t('editor.boxSelectHint')}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// definition <-> xyflow shape translation
// ---------------------------------------------------------------------------

/**
 * Decision oracle for the hidden-mount refit (pure — see the ResizeObserver
 * effect in CanvasInner). `armed` starts as `null` (nothing observed yet):
 * - first observation decides arming: a degenerate (zero) size means the
 *   canvas mounted inside a hidden pane and the init fitView was garbage;
 * - while armed, the first real size flips `refit` (caller fits + stops
 *   observing); further zero sizes keep waiting;
 * - a canvas whose first observation is already real never arms — its init
 *   fitView was computed against true dimensions and any later resize must
 *   NOT clobber the user's pan/zoom.
 */
export function resolveHiddenMountRefit(
  armed: boolean | null,
  width: number,
  height: number,
): { armed: boolean; refit: boolean } {
  const degenerate = width <= 0 || height <= 0
  if (armed === null) return { armed: degenerate, refit: false }
  if (armed && !degenerate) return { armed: false, refit: true }
  return { armed, refit: false }
}

interface PortInventory {
  inputs: string[]
  outputs: string[]
}

export function computePorts(
  node: WorkflowNode,
  agentByName: Map<string, Agent>,
  definition: WorkflowDefinition,
): PortInventory {
  const inputs: string[] = []
  const outputs: string[] = []

  // Inputs derived from inbound edges (any target node) so users can see
  // which prompt vars / output ports are wired up on this node.
  //
  // RFC-060 §3 — skip `boundary: 'wrapper-output'` edges. Their target is
  // conceptually an OUTPUT port of the wrapper-fanout (re-used as a target
  // so the inner aggregator can drag boundary-output edges onto it); the
  // declared output is already surfaced via the declaration table below.
  // Without this skip the boundary-output edge would also append the output
  // port name to `inputs[]`, drawing a phantom INPUT port row on the
  // wrapper's left side that mirrors the output port name — symmetric to
  // the inputs-leak-into-outputs bug fixed in the outputs fallback at the
  // bottom of this function.
  for (const e of definition.edges) {
    if (
      e.target.nodeId === node.id &&
      e.boundary !== 'wrapper-output' &&
      !inputs.includes(e.target.portName)
    ) {
      inputs.push(e.target.portName)
    }
  }

  // RFC-146: the per-kind switch that lived here (fork #1 of five parallel
  // port derivations) moved to the shared declaration table. The canvas
  // renders the DATA projection only — system channels (clarify family,
  // __clarify__/…) keep their historical "render only when an edge exists"
  // behavior via the edge-derived passes around this block.
  const declared = declaredPorts(node, definition, agentByName)
  for (const p of declared.dataInputs) {
    if (!inputs.includes(p.name)) inputs.push(p.name)
  }
  for (const p of declared.dataOutputs) outputs.push(p.name)

  // Final pass: any outbound edge referencing a port we didn't declare above
  // (stale snapshot vs edited agent/wrapper definition, or a system channel
  // such as `__clarify__`) still needs a Handle so xyflow can route the
  // edge. Without this, the edge silently disappears and the console fills
  // with "Couldn't create edge for source handle id".
  //
  // RFC-060 §3 — skip `boundary: 'wrapper-input'` edges here. Their source
  // is conceptually an INPUT port of the wrapper-fanout (re-used as a source
  // so users can drag boundary-input edges into inner nodes); appending the
  // input port name to `outputs[]` would render a phantom OUTPUT port on the
  // wrapper's right side that mirrors the input port name (the duplicate
  // user-visible bug after the dual-purpose-handle landing). The matching
  // left-side input Handle is already declared above (declaration-table
  // dataInputs), so xyflow can route the edge without this fallback.
  for (const e of definition.edges) {
    if (
      e.source.nodeId === node.id &&
      e.boundary !== 'wrapper-input' &&
      !outputs.includes(e.source.portName)
    ) {
      outputs.push(e.source.portName)
    }
  }
  return { inputs, outputs }
}

function toFlowNodes(
  definition: WorkflowDefinition,
  agentByName: Map<string, Agent>,
  statuses?: Record<string, CanvasNodeData['status'] | undefined>,
  // RFC-120 D13: per source-node pending-question counts + the badge click
  // handler. Both optional; when `questionCounts` is undefined no node gets a
  // `questionCount` (golden-lock — data is byte-for-byte identical to before).
  questionCounts?: Record<string, number>,
  onQuestionBadgeClick?: (nodeId: string) => void,
  // RFC-122: per-(task, asking-node) clarify directive map + toggle handler. When
  // `clarifyDirectives` is undefined (editor canvas) no node gets a
  // `clarifyDirective` (golden-lock — data byte-for-byte identical to before).
  clarifyDirectives?: Record<string, ClarifyDirective>,
  onClarifyDirectiveToggle?: (nodeId: string, next: ClarifyDirective) => void,
  // RFC-158: per review-node click target. When `reviewNavs` is undefined
  // (editor canvas) no review node gets a `reviewNav` (golden-lock — data
  // byte-for-byte identical to before).
  reviewNavs?: Record<string, 'awaiting' | 'decided'>,
  // RFC-161: per clarify/cross-clarify-node click target. When `clarifyNavs` is
  // undefined (editor canvas) no clarify node gets a `clarifyNav` (golden-lock).
  clarifyNavs?: Record<string, 'awaiting' | 'answered'>,
  onAddInsideWrapper?: (wrapperNodeId: string, trigger?: HTMLElement | null) => void,
  validationCounts?: Readonly<Record<string, WorkflowValidationCounts | undefined>>,
  surface: WorkflowCanvasSurface = 'task',
): Node[] {
  const loopBodyIds = new Set<string>()
  for (const n of definition.nodes) {
    if (n.kind !== 'wrapper-loop') continue
    const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
    if (Array.isArray(inner)) for (const id of inner) loopBodyIds.add(id)
  }
  return definition.nodes.map((n, idx) => {
    const ports = computePorts(n, agentByName, definition)
    const data: CanvasNodeData = {
      surface,
      nodeId: n.id,
      kind: n.kind,
      title: nodeTitle(n),
      inputPorts: ports.inputs,
      outputPorts: ports.outputs,
    }
    if (statuses !== undefined) {
      const s = statuses[n.id]
      if (s !== undefined) data.status = s
    }
    const validation = validationCounts?.[n.id]
    if (validation !== undefined) data.validation = validation
    // RFC-120 D13: paint a question badge only when this node has pending
    // questions. The click handle rides along on the same data so the badge can
    // jump to the board; both stay absent when `questionCounts` isn't supplied.
    if (questionCounts !== undefined) {
      const c = questionCounts[n.id]
      if (c !== undefined && c > 0) {
        data.questionCount = c
        if (onQuestionBadgeClick !== undefined) data.onQuestionBadgeClick = onQuestionBadgeClick
      }
    }
    // RFC-122: paint the clarify directive toggle on asking-agent nodes only
    // (isClarifyAskingNode keys on the same `__clarify__` source edge the runtime
    // gates ask-back for — so it never lands on the clarify / clarify-cross-agent
    // CHANNEL nodes). Default 'continue' when no override row exists. Both stay
    // absent when `clarifyDirectives` isn't supplied (editor canvas → no toggle).
    if (clarifyDirectives !== undefined && isClarifyAskingNode(definition, n.id)) {
      data.clarifyDirective = clarifyDirectives[n.id] ?? 'continue'
      if (onClarifyDirectiveToggle !== undefined) {
        data.onClarifyDirectiveToggle = onClarifyDirectiveToggle
      }
    }
    // RFC-158: mark a review node's click target so ReviewNode can render the
    // "click to open review / view latest conclusion" hint + pointer cursor.
    // Only review nodes present in `reviewNavs` get it; absent ⇒ not clickable.
    // Undefined map (editor canvas) ⇒ no review node ever gets it (golden-lock).
    if (reviewNavs !== undefined && n.kind === 'review') {
      const nav = reviewNavs[n.id]
      if (nav !== undefined) data.reviewNav = nav
    }
    // RFC-161: mark a clarify / cross-clarify node's click target so the node can
    // render the "click to answer / view answers" hint + pointer cursor. Only the
    // two clarify kinds present in `clarifyNavs` get it; absent ⇒ not clickable.
    // Undefined map (editor canvas) ⇒ no clarify node ever gets it (golden-lock).
    if (clarifyNavs !== undefined && (n.kind === 'clarify' || n.kind === 'clarify-cross-agent')) {
      const nav = clarifyNavs[n.id]
      if (nav !== undefined) data.clarifyNav = nav
    }
    if (loopBodyIds.has(n.id)) data.loopBody = true
    if (isWrapperKind(n.kind)) {
      const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
      ;(data as CanvasNodeData & { innerCount?: number }).innerCount = inner?.length ?? 0
      if (onAddInsideWrapper !== undefined) data.onAddInsideWrapper = onAddInsideWrapper
    }
    if (n.kind === 'wrapper-loop') {
      // RFC-016: surface maxIterations + exitCondition.kind onto node data so
      // the header pill (× N · kind) can render without re-reading the def.
      const rec = n as unknown as Record<string, unknown>
      const maxIter = typeof rec.maxIterations === 'number' ? rec.maxIterations : undefined
      const exitCondRaw = rec.exitCondition as { kind?: unknown } | undefined
      const exitKind = typeof exitCondRaw?.kind === 'string' ? exitCondRaw.kind : undefined
      ;(
        data as CanvasNodeData & {
          maxIterations?: number
          exitConditionKind?: string
        }
      ).maxIterations = maxIter
      ;(
        data as CanvasNodeData & {
          maxIterations?: number
          exitConditionKind?: string
        }
      ).exitConditionKind = exitKind
    }
    if (n.kind === 'review') {
      // RFC-007: surface inputSource onto node data so ReviewNode can show
      // the configured upstream `node.port` summary inside the card body.
      const raw = (n as unknown as { inputSource?: { nodeId?: unknown; portName?: unknown } })
        .inputSource
      if (raw !== undefined) {
        const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : ''
        const portName = typeof raw.portName === 'string' ? raw.portName : ''
        const reviewData = data as CanvasNodeData & {
          inputSource?: { nodeId: string; portName: string }
          inputSourceTitle?: string
        }
        reviewData.inputSource = { nodeId, portName }
        const sourceNode = definition.nodes.find((candidate) => candidate.id === nodeId)
        if (sourceNode !== undefined) reviewData.inputSourceTitle = nodeTitle(sourceNode)
      }
    }
    // RFC-060 PR-E: agent-multi sourcePort mirroring removed.
    if (n.kind === 'wrapper-fanout') {
      // Surface the shard-source input port name (if any) so WrapperNodes
      // can render that left-side row with shard-source chrome — gives
      // authors a glance-distinguishable cue for which input port drives
      // the fan-out vs which ones broadcast.
      const declaredInputs = Array.isArray((n as Record<string, unknown>).inputs)
        ? ((n as Record<string, unknown>).inputs as Array<{
            name?: unknown
            isShardSource?: unknown
          }>)
        : []
      const shardSrc = declaredInputs.find(
        (p) => p.isShardSource === true && typeof p.name === 'string',
      )
      if (shardSrc !== undefined && typeof shardSrc.name === 'string') {
        ;(data as CanvasNodeData & { shardSourcePort?: string }).shardSourcePort = shardSrc.name
      }
    }
    return {
      id: n.id,
      type: n.kind,
      position: effectiveWorkflowNodePosition(n, idx),
      data,
    }
  })
}

// RFC-146 T4: the display-title rule moved to ./nodeTitle (single source,
// now including the `review:<port>` case the candidates fork carried);
// re-exported here to keep the historical import surface.
export { nodeTitle }

function workflowInsertableEdgeIds(
  definition: WorkflowDefinition,
  context: ReturnType<typeof createWorkflowSemanticContext>,
): Set<string> {
  const ids = new Set<string>()
  for (const edge of definition.edges) {
    if (isWorkflowEdgeInsertable(definition, edge.id, context)) ids.add(edge.id)
  }
  return ids
}

function toFlowEdges(
  defEdges: WorkflowDefinition['edges'],
  controlFlowEdgeIds?: ReadonlySet<string>,
  insertableEdgeIds?: ReadonlySet<string>,
  edgeInsertion?: {
    surface: WorkflowCanvasSurface
    readOnly: boolean | undefined
    hasChangeHandler: boolean
    onInsertNode: NonNullable<WorkflowCanvasEdgeData['onInsertNode']>
  },
  validationCounts?: Readonly<Record<string, WorkflowValidationCounts | undefined>>,
): Edge[] {
  const onInsertNode =
    edgeInsertion !== undefined &&
    canShowEdgeInsertAffordance(
      edgeInsertion.surface,
      edgeInsertion.readOnly,
      edgeInsertion.hasChangeHandler,
    )
      ? edgeInsertion.onInsertNode
      : undefined
  return defEdges.map((e) => {
    const insertable = insertableEdgeIds?.has(e.id) === true && onInsertNode !== undefined
    const validation = validationCounts?.[e.id]
    const validationClass =
      validation === undefined
        ? undefined
        : validation.errors > 0
          ? 'canvas-edge--validation-error'
          : 'canvas-edge--validation-warning'
    const className = [
      controlFlowEdgeIds?.has(e.id) ? CONTROL_FLOW_EDGE_CLASS : undefined,
      validationClass,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' ')
    return {
      id: e.id,
      source: e.source.nodeId,
      target: e.target.nodeId,
      sourceHandle: e.source.portName,
      targetHandle: e.target.portName,
      // RFC-060 signal ports carry no data — render their edge as a grey dashed
      // control-flow line (styles.css `.canvas-edge--control`). Absent set ⇒ no
      // tagging, so the existing unit-test call sites round-trip unchanged.
      ...(className === '' ? {} : { className }),
      ...(insertable || validation !== undefined
        ? {
            type: 'workflow-insertable',
            data: {
              ...(insertable ? { onInsertNode } : {}),
              ...(validation !== undefined ? { validation } : {}),
            } satisfies WorkflowCanvasEdgeData,
          }
        : {}),
    }
  })
}

/**
 * Returns true when at least one of the xyflow NodeChanges modifies the
 * persisted WorkflowDefinition in a way we want to round-trip through the
 * parent immediately.
 *
 * Excluded:
 * - `select` / `dimensions`: pure xyflow UI state. Propagating them mints a
 *   new definition reference, the def-sync useEffect rebuilds the local
 *   nodes array, which retriggers onNodesChange → React eventually trips
 *   "Maximum update depth exceeded".
 * - `position`: xyflow fires this on every drag tick (≈60Hz). If we
 *   commitChange on each tick the def-sync useEffect immediately overwrites
 *   the locally-updated node positions with `toDefinition`'s rounded copy,
 *   which (a) fights xyflow's sub-pixel drag state and (b) causes a visible
 *   flicker — the whole canvas re-renders mid-drag. Drag-end positions are
 *   committed once via `onNodeDragStop` instead.
 */
function affectsDefinition(changes: NodeChange[]): boolean {
  return changes.some((c) => c.type === 'add' || c.type === 'remove' || c.type === 'replace')
}

/**
 * Pure controlled-state projection for one xyflow node-change batch. Keeping
 * incident-edge filtering here makes React replay harmless: callers can run
 * the same batch more than once and receive the same projection without any
 * setter, parent commit or input mutation occurring inside the calculation.
 */
export function reconcileFlowNodeChanges(
  changes: NodeChange[],
  currentNodes: Node[],
  currentEdges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const nodes = applyNodeChanges(changes, currentNodes)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = currentEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  return { nodes, edges }
}

/**
 * Edge equivalent of {@link affectsDefinition}. xyflow fires `select`
 * (and other UI-only) changes on every edge interaction; only structural
 * mutations should round-trip into the persisted WorkflowDefinition.
 *
 * Regression: the prior `handleEdgesChange` filtered for `'remove'`-only
 * and silently dropped `select` — edges never got `selected: true`, the
 * EdgeInspector entry point was unreachable. Tests in
 * `tests/canvas-edge-changes.test.ts` lock this behavior in.
 */
export function affectsEdgeDefinition(changes: EdgeChange[]): boolean {
  return changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace')
}

/** True when a connection targets a wrapper kind that has no inbound ports. */
export function isUnsupportedWrapperInbound(
  definition: WorkflowDefinition,
  connection: { target?: string | null },
): boolean {
  if (connection.target === null || connection.target === undefined) return false
  const target = definition.nodes.find((node) => node.id === connection.target)
  return target?.kind === 'wrapper-git' || target?.kind === 'wrapper-loop'
}

/**
 * Translate an xyflow Connection landing on the catch-all left handle
 * (RFC-003) into a regular connection: target portName defaults to the
 * source portName, matching design proposal §3.5 "input port defaults to
 * the upstream output port name". Connections to a specific named handle
 * pass through untouched.
 *
 * Exported for unit tests.
 */
export function translateInboundConnection(conn: Connection): Connection {
  if (conn.targetHandle === INBOUND_HANDLE_ID) {
    return { ...conn, targetHandle: conn.sourceHandle ?? null }
  }
  return conn
}

/**
 * Returns a new array with `selected: false` applied to every item that
 * currently has `selected: true`, and the same reference otherwise. Used
 * by the imperative `clearSelection` handle to deselect xyflow's edges /
 * nodes when the EdgeInspector / NodeInspector ✕ closes — otherwise the
 * edge stays highlighted AND becomes un-reclickable because xyflow emits
 * no new `select` change and our dedupe in `onEdgeClick` (keyed by
 * `lastEmittedSelectionSig`) swallows the click.
 *
 * Exported for unit tests.
 */
export function clearFlowSelection<T extends { selected?: boolean }>(items: T[]): T[] {
  if (!items.some((it) => it.selected === true)) return items
  return items.map((it) => (it.selected === true ? { ...it, selected: false } : it))
}

/**
 * Returns a new array with `selected: true` applied to every item whose
 * id is in `selectedIds`. Used by the def-sync useEffect to preserve the
 * xyflow `selected` flag when rebuilding nodes/edges from a new
 * definition reference. Without this, any inspector edit (which mints a
 * new definition) wiped the selected flag, xyflow saw the node go from
 * selected to not-selected, fired onSelectionChange with empty arrays,
 * and the inspector closed on every keystroke.
 *
 * Reference-stable when no item needs flipping — same rationale as
 * {@link clearFlowSelection}.
 *
 * Exported for unit tests.
 */
export function applySelection<T extends { id: string; selected?: boolean }>(
  items: T[],
  selectedIds: string[],
): T[] {
  if (selectedIds.length === 0) return items
  const sel = new Set(selectedIds)
  if (!items.some((it) => sel.has(it.id) && it.selected !== true)) return items
  return items.map((it) =>
    sel.has(it.id) && it.selected !== true ? { ...it, selected: true } : it,
  )
}

/**
 * Stable string fingerprint of a CanvasSelection. Two selections with the
 * same kind+id produce the same string so we can dedupe parent re-renders
 * without comparing object references — see the `lastEmittedSelectionSig`
 * guard in onSelectionChange (regression: clicking a node used to trip
 * "Maximum update depth exceeded" because xyflow's StoreUpdater re-fired
 * onSelectionChange after every parent re-render).
 *
 * Exported for unit tests.
 */
export function selectionSig(sel: CanvasSelection | null): string {
  return sel === null ? 'null' : `${sel.kind}:${sel.id}`
}

/**
 * Map a canvas selection (one node, or one edge, or anything else) to the
 * `CanvasSelection` shape consumed by the editor route. Multi-selections
 * and empty selections both collapse to `null` — the inspector drawer
 * only meaningfully works on a single subject.
 */
export function deriveSelection(nodeIds: string[], edgeIds: string[]): CanvasSelection | null {
  if (nodeIds.length === 1 && edgeIds.length === 0 && nodeIds[0] !== undefined) {
    return { kind: 'node', id: nodeIds[0] }
  }
  if (nodeIds.length === 0 && edgeIds.length === 1 && edgeIds[0] !== undefined) {
    return { kind: 'edge', id: edgeIds[0] }
  }
  return null
}

/**
 * One immutable oracle for the local xyflow selection, the single-subject
 * route inspector, and the callback de-duplication signature. Multi-select
 * remains highlighted locally while deliberately collapsing the inspector
 * subject to null.
 */
export function buildCanvasSelectionSync(
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): {
  local: { nodes: string[]; edges: string[] }
  route: CanvasSelection | null
  signature: string
} {
  const local = { nodes: [...nodeIds], edges: [...edgeIds] }
  const route = deriveSelection(local.nodes, local.edges)
  return { local, route, signature: selectionSig(route) }
}

/**
 * Reference-stable equality for two id lists in document order. Used by
 * the onSelectionChange handler so we can keep the previous selection
 * object reference (and avoid a setState re-render storm) when xyflow
 * fires the same selection back at us after every nodes-update.
 */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toDefinition(
  prev: WorkflowDefinition,
  flowNodes: Node[],
  flowEdges: Edge[],
  measuredSizes?: Map<string, { width: number; height: number }>,
): WorkflowDefinition {
  // RFC-016: xyflow hands us children with parent-relative positions; invert
  // to absolute coords before reading position into the persisted def.
  const absolute = projectXyflowPositionsToAbsolute(prev, flowNodes, measuredSizes)
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = absolute
    .map((fn) => {
      const orig = prevById.get(fn.id)
      if (orig === undefined) return null
      const out: WorkflowNode = {
        ...orig,
        position: { x: Math.round(fn.position.x), y: Math.round(fn.position.y) },
      }
      // RFC-016: persist wrapper.size when xyflow has resolved it (either
      // from our projection layer or a user-driven NodeResizer drag). Only
      // wrapper nodes get this; non-wrappers leave size untouched.
      if (isWrapperKind(out.kind)) {
        const style = fn.style as { width?: unknown; height?: unknown } | undefined
        const w = typeof style?.width === 'number' ? style.width : undefined
        const h = typeof style?.height === 'number' ? style.height : undefined
        if (w !== undefined && h !== undefined) {
          const prevSize = (orig as Record<string, unknown>).size as
            | { sizeLocked?: unknown }
            | undefined
          const sizeLocked = prevSize?.sizeLocked === true
          ;(out as Record<string, unknown>).size = sizeLocked
            ? { width: Math.round(w), height: Math.round(h), sizeLocked: true }
            : { width: Math.round(w), height: Math.round(h) }
        }
      }
      return out
    })
    .filter((n): n is WorkflowNode => n !== null)

  const stillIds = new Set(nextNodes.map((n) => n.id))
  const keptEdges = prev.edges.filter(
    (e) => stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
  )
  const liveById = new Set(flowEdges.map((e) => e.id))
  const nextEdges: WorkflowEdge[] = keptEdges.filter((e) => liveById.has(e.id))

  return {
    ...prev,
    nodes: nextNodes,
    edges: nextEdges,
  }
}

/**
 * Validate an xyflow Connection event against the current definition and
 * convert it to a WorkflowEdge. Returns null when:
 *   - either side is missing nodeId or handle/port
 *   - it's a self-loop (target.nodeId === source.nodeId)
 *   - an identical edge already exists (same source+target port pair)
 *
 * Port name correctness is left to P-2-01's validator; the canvas just
 * captures the wire and lets save-time validation surface mismatches.
 */
export function buildEdgeFromConnection(
  def: WorkflowDefinition,
  conn: {
    source?: string | null
    target?: string | null
    sourceHandle?: string | null
    targetHandle?: string | null
  },
): WorkflowEdge | null {
  const source = conn.source ?? ''
  const target = conn.target ?? ''
  const sourcePort = conn.sourceHandle ?? ''
  const targetPort = conn.targetHandle ?? ''
  if (source === '' || target === '' || sourcePort === '' || targetPort === '') return null
  if (source === target) return null
  const duplicate = def.edges.some(
    (e) =>
      e.source.nodeId === source &&
      e.source.portName === sourcePort &&
      e.target.nodeId === target &&
      e.target.portName === targetPort,
  )
  if (duplicate) return null
  return {
    id: `edge_${ulid().slice(-6).toLowerCase()}`,
    source: { nodeId: source, portName: sourcePort },
    target: { nodeId: target, portName: targetPort },
  }
}

// Compatibility re-exports for the pre-RFC-199 golden fixtures. Production
// connection paths consume these only through workflow-connection-plan /
// workflow-transition.
export {
  ensureWrapperFanoutInputForEdge,
  markBoundaryWrapperInput,
  markBoundaryWrapperOutput,
} from '../../lib/workflow-connection-boundary'

function isWrapperNode(def: WorkflowDefinition, nodeId: string | null): boolean {
  if (nodeId === null) return false
  const n = def.nodes.find((x) => x.id === nodeId)
  return n !== undefined && isWrapperKind(n.kind)
}

// Test helpers (exported but underscored).
export const __testToFlowNodes = (
  defNodes: WorkflowDefinition['nodes'],
  agents: Agent[] = [],
  edges: WorkflowEdge[] = [],
  statuses?: Record<string, CanvasNodeData['status'] | undefined>,
  questionCounts?: Record<string, number>,
  onQuestionBadgeClick?: (nodeId: string) => void,
  // RFC-122: directive map + toggle handler, so the toggle-threading is testable
  // the same way the question badge is.
  clarifyDirectives?: Record<string, ClarifyDirective>,
  onClarifyDirectiveToggle?: (nodeId: string, next: ClarifyDirective) => void,
  // RFC-158: review-node click targets, so the reviewNav-threading is testable
  // the same way questionCounts / clarifyDirectives are.
  reviewNavs?: Record<string, 'awaiting' | 'decided'>,
  // RFC-161: clarify-node click targets, so clarifyNav-threading is testable too.
  clarifyNavs?: Record<string, 'awaiting' | 'answered'>,
  onAddInsideWrapper?: (wrapperNodeId: string, trigger?: HTMLElement | null) => void,
  surface: WorkflowCanvasSurface = 'task',
): Node[] => {
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: defNodes,
    edges,
  }
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const map = buildNodeAgentLookup(agents, (a) => a)
  return toFlowNodes(
    def,
    map,
    statuses,
    questionCounts,
    onQuestionBadgeClick,
    clarifyDirectives,
    onClarifyDirectiveToggle,
    reviewNavs,
    clarifyNavs,
    onAddInsideWrapper,
    undefined,
    surface,
  )
}
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
export const __testComputePorts = computePorts
export const __testAffectsDefinition = affectsDefinition
export const __testSameIds = sameIds
