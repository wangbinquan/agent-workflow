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
  getViewportForBounds,
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
  useNodesInitialized,
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
  ancestryUnchanged,
  buildNodeAgentLookup,
  CODE_HOST_ACTION_DEFS,
  CODE_HOST_METHODS,
  declaredPorts,
  isCodeHostAction,
  isClarifyAskingNode,
  isUnsupportedBinding,
  isWrapperKind,
  type WorkflowByRef,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { CallNodeNavKind } from '@/lib/call-node-nav'
import { AgentNode } from './nodes/AgentNode'
import { CallWorkflowNode } from './nodes/CallWorkflowNode'
import { CodeHostCallNode, type CodeHostCallNodeData } from './nodes/CodeHostCallNode'
import { CallWorkgroupNode } from './nodes/CallWorkgroupNode'
import { useWorkflowRefResolver } from './useWorkflowRefResolver'
import { usePrivilegedNodes } from '@/hooks/usePrivilegedNodes'
import { applyPaste, buildSlice, getClipboard, setClipboard } from './canvasClipboard'
import { classifyClarifyConnection } from './clarifyDragHelper'
import { classifyCrossClarifyConnection } from './crossClarifyDragHelper'
import { existingInputPorts, namedInputDropPolicy, nextFreeInputPort } from './dropTarget'
import { getNodeBoxes, resolveDropTarget } from './connectResolve'
import { buildControlFlowEdgeIds, CONTROL_FLOW_EDGE_CLASS } from './controlFlowEdge'
import { nodeAgentDisplayName, nodeTitle } from './nodeTitle'
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
import { ScriptNode, type ScriptNodeData } from './nodes/ScriptNode'
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
import {
  buildWrapperPortMinimumSizes,
  DEFAULT_NODE_SIZE_BY_KIND,
  fitWrapperToInner,
} from './wrapperFit'
import {
  applyWrapperDragPreviews,
  clearWrapperDragPreviews,
  computeWrapperDragPreviews,
} from './wrapperDragPreview'
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
import {
  OVERVIEW_MAX_ZOOM,
  READABLE_FOCUS_ZOOM,
  READABLE_MIN_ZOOM,
  canShowCanvasInlineActions,
  canvasEdgeFocusPoint,
  canvasFocusPointWithRightOcclusion,
  canvasNodeFocusPoint,
  chooseCanvasFocalNode,
  planInitialCanvasCamera,
  resolveCanvasZoomBand,
  type CanvasCameraMode,
  type CanvasZoomBand,
} from './canvasCamera'

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
  // RFC-243 — call-workflow invokes another workflow as a child task.
  'call-workflow': CallWorkflowNode,
  // RFC-243 PR-4 — call-workgroup hands the stage to a workgroup child task.
  'call-workgroup': CallWorkgroupNode,
  // RFC-253 — script node card.
  script: ScriptNode,
  'code-host-call': CodeHostCallNode,
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
  /**
   * Monotonic route-owned epoch for an explicitly accepted authoritative
   * load. Definition/query identities are intentionally not camera keys:
   * ambient refetches and local edits must preserve the user's viewport.
   */
  authoritativeLoadEpoch?: number
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
  /**
   * RFC-245: per call-workflow/call-workgroup-node click target, keyed by workflow
   * node id. When DEFINED (task-detail canvas) a call node with an entry renders a
   * click-to-open-child hint + pointer cursor; nodes absent from the map are not
   * clickable (and, per design D1, never fall back to the drawer). Undefined
   * (editor canvas) ⇒ no hints, byte-for-byte unchanged (golden-lock). Changing
   * this map rebuilds node data like `reviewNavs` / `clarifyNavs` do.
   */
  callNavs?: Record<string, CallNodeNavKind>
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

function workflowEntryNodeIds(definition: WorkflowDefinition): string[] {
  const withIncoming = new Set(definition.edges.map((edge) => edge.target.nodeId))
  return definition.nodes.filter((node) => !withIncoming.has(node.id)).map((node) => node.id)
}

function canvasCameraDuration(): number {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 180
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
  authoritativeLoadEpoch,
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
  callNavs,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  handleRef,
}: WorkflowCanvasProps & {
  handleRef?: React.ForwardedRef<WorkflowCanvasHandle>
}) {
  const { t, i18n } = useTranslation()
  const canvasLanguage = i18n.resolvedLanguage ?? i18n.language
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
  // RFC-243 — shared child-workflow resolver for call-workflow port
  // derivation (declaredPorts 4th arg). Identity only changes when the
  // ['workflows'] cache entry does, so it can drive the def-sync ref-guard.
  const { workflowByRef } = useWorkflowRefResolver()
  // RFC-270 — the single privileged-node judgement for this canvas: palette
  // grey-out, node drag/delete, edge wiring and the drag-stop ancestry guard
  // all read it, so they cannot drift into a half-open combination.
  const { paletteDisabledReason, protectedNodeIds } = usePrivilegedNodes()
  const protectedIds = useMemo(() => protectedNodeIds(definition), [definition, protectedNodeIds])
  const semanticContext = useMemo(() => createWorkflowSemanticContext(agents ?? []), [agents])
  const validationProjection = useMemo(
    () => projectWorkflowValidationIssues(definition, validationIssues),
    [definition, validationIssues],
  )
  const rf = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const editableEditor = surface === 'editor' && readOnly !== true && onChange !== undefined
  const coarsePointerRef = useRef(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  )
  const initialZoomBand = resolveCanvasZoomBand(1)
  const [cameraMode, setCameraMode] = useState<CanvasCameraMode>('readable-focus')
  const [zoomBand, setZoomBand] = useState<CanvasZoomBand>(initialZoomBand)
  const zoomBandRef = useRef<CanvasZoomBand>(initialZoomBand)
  const initialInlineActionsVisible = canShowCanvasInlineActions(1, coarsePointerRef.current)
  const [inlineActionsVisible, setInlineActionsVisible] = useState(initialInlineActionsVisible)
  const inlineActionsVisibleRef = useRef(initialInlineActionsVisible)
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
      // RFC-270（Codex 实现门 P2）—— 这里曾经放过一道「中央守卫」：拿两个 author
      // 门的敏感投影比对 `definition` 与 `result.next`，任何触碰特权节点执行面的
      // 本地提交一律当场拒绝。想法是对的（这是画布唯一的 `onChange` 出口，一处
      // 设卡就覆盖 EdgeInspector / Connect Next / 右键菜单 / 复制粘贴等全部入口），
      // 但**上线即回归**：用户实报「工作流里只要有脚本或代码平台调用节点，连移动
      // 别的节点都被拦下」。`applyWorkflowTransition` 在 `replace-definition` 上还会
      // 跑 `reconcileRemovalAndReferences` / `applyInputDeclarationSync` /
      // `reconcileDerivedPorts`（workflow-transition.ts:749-751），比较的两端因此
      // 跨了一层归一化；最小复现里纯移动**不**触发，说明真实形状另有原因，未定位。
      //
      // 撤回而不是赌一个没验证过的修法：它要改善的只是「本地做得成、保存时 403」，
      // 而回归拦掉的是基本操作，代价高得多。判据函数 `privilegedProjectionChange`
      // 与其用例保留在 shared，重上时直接复用；未覆盖的编辑入口登记在
      // `docs/audit-backlog.md`。
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
  useEffect(() => {
    if (!editableEditor) return
    wrapperRef.current?.style.setProperty('--workflow-canvas-zoom', '1')
    wrapperRef.current?.style.setProperty('--workflow-canvas-inverse-zoom', '1')
  }, [editableEditor])
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
        editableEditor && inlineActionsVisible ? handleAddInsideWrapper : undefined,
        validationProjection.nodes,
        surface,
        workflowByRef,
        callNavs,
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
        showInlineActions: inlineActionsVisible,
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
  // RFC-245: same shape for call-node click targets — the map flips when the
  // node-runs query stamps a childTaskId OR when the ACL-filtered children query
  // resolves (design D5/D9), both without touching the definition.
  const externalCallNavsRef = useRef(callNavs)
  const externalValidationIssuesRef = useRef(validationIssues)
  const externalEdgeInsertEnabledRef = useRef(edgeInsertEnabled)
  const externalInlineActionsVisibleRef = useRef(inlineActionsVisible)
  // Localized default titles are projected into xyflow node data. A language
  // switch does not change the workflow definition, so it needs its own rebuild
  // signal or cards keep the previous language until the next edit/reload.
  const externalLanguageRef = useRef(canvasLanguage)
  // RFC-243: mirror of the agents late-load guard for the child-workflow
  // resolver — the ['workflows'] query resolves after mount, and without a
  // resolver-changed arm a call-workflow node would keep zero port rows
  // until the next definition edit.
  const externalWorkflowByRefRef = useRef(workflowByRef)
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

  const nodeCameraPoint = useCallback(
    (nodeId: string) => {
      const node = rf.getInternalNode(nodeId)
      if (node === undefined) return null
      const width = node.measured.width ?? node.width ?? 0
      const height = node.measured.height ?? node.height ?? 0
      return canvasNodeFocusPoint({
        x: node.internals.positionAbsolute.x,
        y: node.internals.positionAbsolute.y,
        width,
        height,
        kind: node.type,
      })
    },
    [rf],
  )

  const focusCanvasSelection = useCallback(
    (target: CanvasSelection): boolean => {
      let point = target.kind === 'node' ? nodeCameraPoint(target.id) : null
      if (target.kind === 'edge') {
        const edge = definition.edges.find((candidate) => candidate.id === target.id)
        if (edge !== undefined) {
          const source = nodeCameraPoint(edge.source.nodeId)
          const destination = nodeCameraPoint(edge.target.nodeId)
          if (source !== null && destination !== null) {
            point = canvasEdgeFocusPoint(source, destination)
          }
        }
      }
      if (point === null) return false
      const canvasRect = wrapperRef.current?.getBoundingClientRect()
      const compactInspector = document.querySelector<HTMLElement>(
        '.workflow-editor-inspector-surface-dialog.workflow-editor-surface-dialog--compact',
      )
      if (canvasRect !== undefined && compactInspector !== null) {
        const inspectorRect = compactInspector.getBoundingClientRect()
        point = canvasFocusPointWithRightOcclusion(
          point,
          READABLE_FOCUS_ZOOM,
          { left: canvasRect.left, right: canvasRect.right },
          { left: inspectorRect.left, right: inspectorRect.right },
        )
      }
      setCameraMode('readable-focus')
      void rf.setCenter(point.x, point.y, {
        zoom: READABLE_FOCUS_ZOOM,
        duration: canvasCameraDuration(),
      })
      return true
    },
    [definition.edges, nodeCameraPoint, rf],
  )

  // Selecting a canvas object can synchronously mount the route-owned
  // Inspector rail, which changes the grid width after this click handler has
  // run. The first frame lets React commit that rail; the second lets
  // ReactFlow's ResizeObserver publish the narrowed viewport before setCenter
  // computes its translation. This is deliberately selection-owned rather
  // than resize-owned: ambient refetches and arbitrary resizes must never take
  // the camera back from the user.
  const selectionFocusRequestRef = useRef(0)
  const cancelPendingSelectionFocus = useCallback(() => {
    selectionFocusRequestRef.current += 1
  }, [])
  const focusSelectionAfterLayout = useCallback(
    (target: CanvasSelection) => {
      const request = ++selectionFocusRequestRef.current
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (selectionFocusRequestRef.current !== request) return
          focusCanvasSelection(target)
        })
      })
    },
    [focusCanvasSelection],
  )
  useEffect(() => cancelPendingSelectionFocus, [cancelPendingSelectionFocus])

  const fallbackReadableNodeId = useCallback(
    () =>
      chooseCanvasFocalNode(
        definition.nodes.map((node) => node.id),
        workflowEntryNodeIds(definition),
        selectionRef.current.nodes[0],
      ),
    [definition],
  )

  const returnToReadableView = useCallback(() => {
    cancelPendingSelectionFocus()
    const selected = singleCanvasSelection(selectionRef.current.nodes, selectionRef.current.edges)
    if (selected !== null && focusCanvasSelection(selected)) return
    const nodeId = fallbackReadableNodeId()
    if (nodeId !== null) focusCanvasSelection({ kind: 'node', id: nodeId })
  }, [cancelPendingSelectionFocus, fallbackReadableNodeId, focusCanvasSelection])

  const showFullGraph = useCallback(() => {
    if (nodesRef.current.length === 0) return
    cancelPendingSelectionFocus()
    setCameraMode('overview')
    void rf.fitView({
      padding: 0.18,
      maxZoom: OVERVIEW_MAX_ZOOM,
      duration: canvasCameraDuration(),
    })
  }, [cancelPendingSelectionFocus, rf])

  const initialCameraOwnerRef = useRef<string | null>(null)
  const applyInitialEditorCamera = useCallback((): boolean => {
    if (!editableEditor || !nodesInitialized) return false
    const owner = JSON.stringify([workflowId ?? '__local-editor__', authoritativeLoadEpoch ?? 0])
    if (initialCameraOwnerRef.current === owner) return false
    const element = wrapperRef.current
    if (element === null) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const liveNodes = nodesRef.current
    if (liveNodes.length === 0) {
      initialCameraOwnerRef.current = owner
      return true
    }
    const liveNodeIds = new Set(liveNodes.map((node) => node.id))
    if (definition.nodes.some((node) => !liveNodeIds.has(node.id))) return false
    const bounds = rf.getNodesBounds(liveNodes)
    const fitViewport = getViewportForBounds(bounds, rect.width, rect.height, 0.2, 2, 0.18)
    const plan = planInitialCanvasCamera({
      allNodesFitZoom: fitViewport.zoom,
      nodeIds: definition.nodes.map((node) => node.id),
      entryNodeIds: workflowEntryNodeIds(definition),
      preferredNodeId: selectionRef.current.nodes[0],
    })
    initialCameraOwnerRef.current = owner
    setCameraMode(plan.mode)
    if (plan.kind === 'fit-all') {
      void rf.fitView({
        padding: 0.18,
        minZoom: READABLE_MIN_ZOOM,
        maxZoom: plan.maxZoom,
        duration: 0,
      })
    } else if (plan.kind === 'focus-node') {
      const point = nodeCameraPoint(plan.nodeId)
      if (point !== null) void rf.setCenter(point.x, point.y, { zoom: plan.zoom, duration: 0 })
    }
    return true
  }, [
    authoritativeLoadEpoch,
    definition,
    editableEditor,
    nodeCameraPoint,
    nodesInitialized,
    rf,
    workflowId,
  ])

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
    (
      nodeIds: readonly string[],
      edgeIds: readonly string[],
      options?: { dedupeRoute?: boolean },
    ): CanvasSelection | null => {
      const next = buildCanvasSelectionSync(nodeIds, edgeIds)
      const routeAlreadyEmitted = lastEmittedSelectionSig.current === next.signature
      selectionRef.current = next.local
      setSelection(next.local)
      lastEmittedSelectionSig.current = next.signature
      if (options?.dedupeRoute !== true || !routeAlreadyEmitted) onSelect?.(next.route)
      return next.route
    },
    [onSelect],
  )

  /**
   * An overview click changes zoom far enough to cross the inline-action
   * threshold. That rebuild runs in the same React event as xyflow's click;
   * relying on its later onSelectionChange leaves selectionRef one render
   * behind, so the rebuild can erase the visual selection while the route has
   * already opened the Inspector. Freeze both semantic and controlled-flow
   * selection before moving the camera, publish the route selection once, and
   * wait for its Inspector layout before moving the camera.
   */
  const activateOverviewSelection = useCallback(
    (target: CanvasSelection) => {
      const nodeIds = target.kind === 'node' ? [target.id] : []
      const edgeIds = target.kind === 'edge' ? [target.id] : []
      syncCanvasSelection(nodeIds, edgeIds, { dedupeRoute: true })

      const nextNodes = applySelection(clearFlowSelection(nodesRef.current), nodeIds)
      const nextEdges = applySelection(clearFlowSelection(edgesRef.current), edgeIds)
      nodesRef.current = nextNodes
      edgesRef.current = nextEdges
      setNodes(nextNodes)
      setEdges(nextEdges)
      focusSelectionAfterLayout(target)
    },
    [focusSelectionAfterLayout, syncCanvasSelection],
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
  const refitRef = useRef<CanvasRefitState>(INITIAL_CANVAS_REFIT)
  useEffect(() => {
    if (!editableEditor || !nodesInitialized) return
    const raf = window.requestAnimationFrame(() => {
      applyInitialEditorCamera()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [applyInitialEditorCamera, editableEditor, nodes, nodesInitialized])

  useEffect(() => {
    const el = wrapperRef.current
    if (el === null) return
    if (refitRef.current.phase === 'pending') {
      const rect = el.getBoundingClientRect()
      refitRef.current = resolveCanvasRefit(refitRef.current, rect.width, rect.height).state
    }
    if (refitRef.current.phase === 'settled') return
    let raf = 0
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry === undefined) return
      const next = resolveCanvasRefit(
        refitRef.current,
        entry.contentRect.width,
        entry.contentRect.height,
      )
      refitRef.current = next.state
      if (!next.refit) return
      ro.disconnect()
      // Next frame: xyflow's own ResizeObservers (same delivery batch) must
      // ingest the new pane dimensions + re-measured node sizes before the
      // fit computes its viewport.
      raf = requestAnimationFrame(() => {
        if (editableEditor) applyInitialEditorCamera()
        else void rf.fitView()
      })
    })
    ro.observe(el)
    // Hard stop on the settle window: past it, a resize is the USER resizing
    // something, and refitting would throw away their pan/zoom.
    const timer = window.setTimeout(() => {
      refitRef.current = settleCanvasRefit(refitRef.current)
      ro.disconnect()
    }, CANVAS_SETTLE_WINDOW_MS)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [applyInitialEditorCamera, editableEditor, rf])

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
    // RFC-245: callNavs map change repaints call-node hints (same shape). Note
    // `callNavs` is ALSO in this effect's dependency array — the ref-guard alone
    // decides "should we rebuild", the dep decides "does the effect run at all"
    // (design-gate P1-3: without the dep, a visibility-only flip left the card's
    // hint/cursor stale while the click closure had already updated).
    const callNavsChanged = callNavs !== externalCallNavsRef.current
    const validationChanged = validationIssues !== externalValidationIssuesRef.current
    const edgeInsertEnabledChanged = edgeInsertEnabled !== externalEdgeInsertEnabledRef.current
    const inlineActionsVisibilityChanged =
      inlineActionsVisible !== externalInlineActionsVisibleRef.current
    const languageChanged = canvasLanguage !== externalLanguageRef.current
    // RFC-243: resolver identity changes exactly when the ['workflows'] cache
    // entry does — repaint call-workflow port rows on child-definition edits.
    const workflowRefsChanged = workflowByRef !== externalWorkflowByRefRef.current
    if (
      defChanged ||
      surfaceChanged ||
      statusChanged ||
      agentsChanged ||
      questionsChanged ||
      directivesChanged ||
      reviewNavsChanged ||
      clarifyNavsChanged ||
      callNavsChanged ||
      validationChanged ||
      edgeInsertEnabledChanged ||
      inlineActionsVisibilityChanged ||
      languageChanged ||
      workflowRefsChanged
    ) {
      externalDefRef.current = definition
      externalSurfaceRef.current = surface
      externalStatusesRef.current = nodeStatuses
      externalAgentsRef.current = agentByName
      externalQuestionCountsRef.current = questionCounts
      externalClarifyDirectivesRef.current = clarifyDirectives
      externalReviewNavsRef.current = reviewNavs
      externalClarifyNavsRef.current = clarifyNavs
      externalCallNavsRef.current = callNavs
      externalValidationIssuesRef.current = validationIssues
      externalEdgeInsertEnabledRef.current = edgeInsertEnabled
      externalInlineActionsVisibleRef.current = inlineActionsVisible
      externalLanguageRef.current = canvasLanguage
      externalWorkflowByRefRef.current = workflowByRef
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
              editableEditor && inlineActionsVisible ? handleAddInsideWrapper : undefined,
              validationProjection.nodes,
              surface,
              workflowByRef,
              callNavs,
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
      if (
        defChanged ||
        agentsChanged ||
        validationChanged ||
        edgeInsertEnabledChanged ||
        inlineActionsVisibilityChanged
      )
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
                showInlineActions: inlineActionsVisible,
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
    // RFC-245 (design-gate P1-3): the ref-guard above is not enough — without
    // this dep the effect never re-runs on a callNavs-only flip and the card's
    // hint/cursor desyncs from the click behavior.
    callNavs,
    canvasLanguage,
    edgeInsertEnabled,
    editableEditor,
    handleInsertNodeOnEdge,
    inlineActionsVisible,
    onChange,
    readOnly,
    semanticContext,
    surface,
    validationIssues,
    validationProjection,
    workflowByRef,
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

  const handleNodeDrag = useCallback(
    (_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => {
      if (readOnly === true || onChange === undefined || draggedNodes.length === 0) return
      // onNodesChange normally updates nodesRef before this callback, but keep
      // the event's dragged positions authoritative when React batches both
      // callbacks in the same frame.
      const draggedById = new Map(draggedNodes.map((node) => [node.id, node] as const))
      const positioned = nodesRef.current.map((node) => {
        const dragged = draggedById.get(node.id)
        if (dragged === undefined) return node
        if (node.position.x === dragged.position.x && node.position.y === dragged.position.y) {
          return node
        }
        return { ...node, position: dragged.position, dragging: dragged.dragging }
      })
      const clean = clearWrapperDragPreviews(positioned)
      const measured = buildMeasuredSizesFromXyflowNodes(clean)
      const previews = computeWrapperDragPreviews({
        definition,
        flowNodes: clean,
        draggedNodeIds: draggedNodes.map((node) => node.id),
        measuredSizes: measured,
      })
      const next = applyWrapperDragPreviews(clean, previews)
      if (next === nodesRef.current) return
      nodesRef.current = next
      setNodes(next)
    },
    [definition, onChange, readOnly],
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
            namedInputDropPolicy(targetNode.kind) !== null &&
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
  // RFC-270 — 受保护节点的画布锁。放在**渲染出口**这一处而不是三个
  // `toFlowNodes` 建表点：状态路径有三条（初始化 + 两个 def-sync effect），在出口
  // 派生才能保证没有哪条路径漏网，也不必给 `toFlowNodes` 那串位置参数再加一个
  // （九个测试文件按位置传参）。
  const lockedNodes = useMemo(
    () => lockPrivilegedFlowNodes(nodes, protectedIds),
    [nodes, protectedIds],
  )
  const lockedEdges = useMemo(
    () => lockPrivilegedFlowEdges(edges, protectedIds),
    [edges, protectedIds],
  )

  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      // RFC-270 — 连线也是改「这个节点执行什么」的一条路：**入边**决定
      // `AW_PORT_*` 取到什么、决定回帖正文是什么。只挡入边，判据与门一致
      // （`inboundEdgeSignature` 只看 `edge.target.nodeId`）——从特权节点**连出去**
      // 不改变它自己的投影，那是门一直允许的普通编辑。
      if (protectedIds.has(conn.target ?? '')) return false
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
            namedInputDropPolicy(targetNode.kind) !== null &&
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
    [definition, protectedIds, semanticContext, taskContext],
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
            editableEditor && inlineActionsVisible ? handleAddInsideWrapper : undefined,
            undefined,
            surface,
            workflowByRef,
            callNavs,
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
            showInlineActions: inlineActionsVisible,
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
      callNavs,
      clarifyDirectives,
      clarifyNavs,
      definition,
      editableEditor,
      handleClarifyDirectiveToggle,
      handleAddInsideWrapper,
      handleQuestionBadgeClick,
      nodeStatuses,
      onChange,
      questionCounts,
      readOnly,
      reviewNavs,
      handleInsertNodeOnEdge,
      inlineActionsVisible,
      semanticContext,
      surface,
      syncCanvasSelection,
      workflowByRef,
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
      const minimumSizes = buildWrapperPortMinimumSizes(nodesRef.current)
      const wrappers = resolveWrappers(definition, measured, minimumSizes)
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
        const minimumSizes = buildWrapperPortMinimumSizes(nodesRef.current)
        const wrappers = resolveWrappers(definition, measured, minimumSizes)
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
      // RFC-270 — permission comes first: it holds for every intent, and unlike
      // the placement reasons below it cannot be resolved by aiming somewhere
      // else. Blocking here also closes the DRAG path, which `aria-disabled`
      // alone never did.
      const permissionReason = paletteDisabledReason(item)
      if (permissionReason !== null) return permissionReason
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
    [
      definition,
      makeEdgeInsertionCandidate,
      nodePickerIntent,
      paletteDisabledReason,
      semanticContext,
      t,
    ],
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
        const minimumSizes = buildWrapperPortMinimumSizes(nodesRef.current)
        const wrapper = resolveWrappers(definition, measured, minimumSizes).get(
          intent.wrapperNodeId,
        )
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
    computePorts(selectedNode, agentByName, definition, workflowByRef).outputs.length > 0
  const selectedCanvasObject = singleCanvasSelection(selection.nodes, selection.edges)

  const openConnectionDialog = useCallback(
    (nodeId: string, trigger: HTMLElement | null) => {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId)
      if (
        node === undefined ||
        computePorts(node, agentByName, definition, workflowByRef).outputs.length === 0
      ) {
        return
      }
      connectionTriggerRef.current = trigger
      setConnectionReplaceEdgeId(null)
      setConnectionSourceNodeId(nodeId)
      setMenu(null)
      onModalSurfaceChange?.('connection')
    },
    [agentByName, definition, onModalSurfaceChange, workflowByRef],
  )

  const openAfterNodePicker = useCallback(
    (nodeId: string, trigger: HTMLElement) => {
      const measured = buildMeasuredSizesFromXyflowNodes(nodesRef.current)
      const minimumSizes = buildWrapperPortMinimumSizes(nodesRef.current)
      const parent = buildParentMap(resolveWrappers(definition, measured, minimumSizes)).get(nodeId)
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
      menuNode !== undefined &&
      computePorts(menuNode, agentByName, definition, workflowByRef).outputs.length > 0
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
    workflowByRef,
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
        cancelPendingSelectionFocus()
        storeApi.getState().unselectNodesAndEdges()
        setSelection((prev) =>
          prev.nodes.length === 0 && prev.edges.length === 0 ? prev : { nodes: [], edges: [] },
        )
        lastEmittedSelectionSig.current = 'null'
      },
      restoreSelection: (nextSelection) => {
        cancelPendingSelectionFocus()
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
        focusSelectionAfterLayout(nextSelection)
      },
    }),
    [
      cancelPendingSelectionFocus,
      definition.edges,
      focusSelectionAfterLayout,
      onModalSurfaceChange,
      openConnectionDialog,
      storeApi,
    ],
  )

  return (
    <div
      ref={wrapperRef}
      className="workflow-canvas"
      data-surface={surface}
      data-camera-mode={editableEditor ? cameraMode : undefined}
      data-zoom-band={editableEditor ? zoomBand : undefined}
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
        nodes={lockedNodes}
        edges={lockedEdges}
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
          const target: CanvasSelection = { kind: 'node', id: node.id }
          if (editableEditor && cameraMode === 'overview') {
            activateOverviewSelection(target)
            return
          }
          // Click-only path; xyflow does not fire this when the gesture
          // becomes a drag. Dedupe via lastEmittedSelectionSig so a second
          // click on the same node doesn't re-emit and re-render.
          const sig = `node:${node.id}`
          if (sig === lastEmittedSelectionSig.current) return
          lastEmittedSelectionSig.current = sig
          if (onSelect !== undefined) onSelect({ kind: 'node', id: node.id })
          if (editableEditor) focusSelectionAfterLayout(target)
        }}
        onEdgeClick={(_, edge) => {
          const target: CanvasSelection = { kind: 'edge', id: edge.id }
          if (editableEditor && cameraMode === 'overview') {
            activateOverviewSelection(target)
            return
          }
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
          if (editableEditor) focusSelectionAfterLayout(target)
        }}
        onPaneClick={() => {
          cancelPendingSelectionFocus()
          // Clicking empty canvas dismisses any open inspector. Without
          // this the inspector stayed open after pane clicks because
          // onSelectionChange no longer drives onSelect.
          if (lastEmittedSelectionSig.current === 'null') return
          lastEmittedSelectionSig.current = 'null'
          if (onSelect !== undefined) onSelect(null)
        }}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={(_evt, _node, draggedNodes) => {
          // Commit final positions once when the drag ends, instead of on
          // every position change. `affectsDefinition` excludes 'position'
          // for the same reason — see its docstring. We send the FULL
          // current `nodes`/`edges` snapshot (not just the dragged ones)
          // because toDefinition computes a complete next-state.
          if (readOnly === true || onChange === undefined) return
          if (draggedNodes.length === 0) return
          const draggedById = new Map(draggedNodes.map((node) => [node.id, node] as const))
          const positioned = nodesRef.current.map((node) => {
            const dragged = draggedById.get(node.id)
            return dragged === undefined
              ? node
              : { ...node, position: dragged.position, dragging: false }
          })
          const liveNodes = clearWrapperDragPreviews(positioned)
          nodesRef.current = liveNodes
          setNodes(liveNodes)
          // RFC-016: with positions about to be committed, decide whether any
          // dragged node also changed wrapper membership (hit a new wrapper
          // rect or left its current one). The membership patches go through
          // applyMembershipPatch on the post-positions definition so the
          // wrapper.nodeIds list stays in lock-step with the visible layout.
          const measured = buildMeasuredSizesFromXyflowNodes(liveNodes)
          const minimumSizes = buildWrapperPortMinimumSizes(liveNodes)
          let nextDef = toDefinition(definition, liveNodes, edgesRef.current, measured)
          // RFC-270 — 被守卫丢弃了归属补丁时置位，用于提示用户「位置提交了，但
          // 归属没动」，不静默。
          let membershipBlocked = false
          const absoluteNodes = projectXyflowPositionsToAbsolute(definition, liveNodes, measured)
          const wrappers: WrapperHitInput[] = []
          for (const fn of liveNodes) {
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
            const patched = applyMembershipPatch(nextDef, patch)
            // RFC-270 — wrapper 归属守卫。受保护节点自己已经拖不动了，但拖动
            // **包着它的** wrapper 仍会改变它的传递归属，而归属正在两个 author
            // 门的敏感投影里 —— 那会把一次纯粹的「挪位置」变成 403，恰好是
            // `scriptAuthorGate.ts` 承诺「无权限也能移动脚本节点」的反面。
            // 判据与门同源（shared `ancestryUnchanged`），不在这里抄一份。
            if (ancestryUnchanged(nextDef, patched, protectedIds)) {
              nextDef = patched
            } else {
              membershipBlocked = true
            }
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
            nextDef = fitWrapperToInner(nextDef, wid, measured, minimumSizes)
          }
          const primaryDragged = draggedNodes[0]?.id
          if (membershipBlocked) {
            announceCanvasChange(t('canvas.privilegedMembershipBlocked'))
          }
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
        // Pan on left / middle / right drag over the empty pane. Node dragging
        // and node / edge clicks still resolve on their child elements
        // (RFC-003 EdgeInspector requires reachable edge clicks). Shift+drag
        // lassos via xyflow default `selectionKeyCode='Shift'`. We deliberately
        // do NOT enable `selectionOnDrag` — it intercepts every left click into
        // a zero-distance lasso and silently swallows edge clicks.
        panOnDrag={readOnly === true ? true : [0, 1, 2]}
        // The moment the user takes the viewport, the settle window closes —
        // no automatic refit may ever clobber their pan/zoom. xyflow passes a
        // null event for PROGRAMMATIC moves (our own fitView animates through
        // this same callback), so the null check is what keeps the refit from
        // settling itself before the layout has finished.
        onMoveStart={(event) => {
          if (event !== null) {
            cancelPendingSelectionFocus()
            refitRef.current = settleCanvasRefit(refitRef.current)
          }
        }}
        onMove={
          editableEditor
            ? (_, viewport) => {
                wrapperRef.current?.style.setProperty(
                  '--workflow-canvas-zoom',
                  String(viewport.zoom),
                )
                wrapperRef.current?.style.setProperty(
                  '--workflow-canvas-inverse-zoom',
                  String(1 / viewport.zoom),
                )
                const nextBand = resolveCanvasZoomBand(viewport.zoom)
                if (nextBand !== zoomBandRef.current) {
                  zoomBandRef.current = nextBand
                  setZoomBand(nextBand)
                }
                const nextInlineVisibility = canShowCanvasInlineActions(
                  viewport.zoom,
                  coarsePointerRef.current,
                )
                if (nextInlineVisibility !== inlineActionsVisibleRef.current) {
                  inlineActionsVisibleRef.current = nextInlineVisibility
                  setInlineActionsVisible(nextInlineVisibility)
                }
              }
            : undefined
        }
        fitView={!editableEditor}
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
        <Controls showFitView={!editableEditor} showInteractive={false} />
        {editableEditor ? (
          <Panel position="top-right" className="workflow-canvas__layout-panel">
            <div role="toolbar" aria-label={t('editor.canvasToolbar')}>
              <button
                type="button"
                className="btn btn--xs btn--primary"
                data-testid="workflow-canvas-add"
                onClick={(event) => openNodePicker(undefined, event.currentTarget)}
              >
                {t('editor.canvasAdd')}
              </button>
              {cameraMode === 'overview' ? (
                <button
                  type="button"
                  className="btn btn--xs"
                  data-testid="workflow-camera-readable"
                  onClick={returnToReadableView}
                >
                  {t('editor.cameraReturnReadable')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--xs"
                  data-testid="workflow-camera-overview"
                  disabled={definition.nodes.length === 0}
                  onClick={showFullGraph}
                >
                  {t('editor.cameraViewFullGraph')}
                </button>
              )}
              <button
                type="button"
                className="btn btn--xs"
                data-testid="workflow-camera-focus-selection"
                disabled={selectedCanvasObject === null}
                onClick={() => {
                  if (selectedCanvasObject !== null) focusCanvasSelection(selectedCanvasObject)
                }}
              >
                {t('editor.cameraFocusSelection')}
              </button>
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
        {editableEditor && selectedNodeId !== null ? (
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

/** How long after mount a size change still counts as "layout settling". */
export const CANVAS_SETTLE_WINDOW_MS = 1200

export type CanvasRefitPhase =
  /** nothing measured yet */
  | 'pending'
  /** mounted degenerate (hidden pane) — waiting for the first real size */
  | 'awaiting-size'
  /** mounted at a real size — watching for the layout to finish settling */
  | 'watching-settle'
  /** terminal: no further automatic refit, ever */
  | 'settled'

export interface CanvasRefitState {
  phase: CanvasRefitPhase
  /** the size `watching-settle` compares against (null in every other phase) */
  size: { width: number; height: number } | null
}

export const INITIAL_CANVAS_REFIT: CanvasRefitState = { phase: 'pending', size: null }

/**
 * Decision oracle for the automatic refit (pure — see the ResizeObserver
 * effect in CanvasInner). Two distinct problems share this state machine:
 *
 * 1. HIDDEN MOUNT. A canvas mounted in a hidden pane (`display:none`)
 *    measures 0×0, so xyflow resolves its queued init fitView against a
 *    degenerate viewport (zoom clamps to minZoom, nodes land off-screen) and
 *    v12 never re-queues the fit when the pane unhides. `pending` + a zero
 *    size arms `awaiting-size`; the first real size refits once.
 *
 * 2. LAYOUT STILL SETTLING. A canvas that mounts at a real size is NOT safe
 *    either: the init fitView runs against whatever the viewport measured at
 *    that instant, and anything that changes the surrounding layout shortly
 *    after (web font swap, a chip that stops wrapping, an image reserving
 *    space) leaves the viewport fitted to a stale box — the nodes render
 *    visibly off-centre and nothing ever corrects them. This is not
 *    hypothetical: the 390px task-detail canvas drifted 37px off-centre on CI
 *    when an UNRELATED `.chip { white-space: nowrap }` landed, because that
 *    shifted the pre-settle layout the init fit had measured. `pending` + a
 *    real size therefore enters `watching-settle`, and the FIRST size change
 *    while watching refits once.
 *
 * Both paths converge on `settled`, which is inert forever after. The caller
 * additionally settles on the user's first pan/zoom and on a
 * CANVAS_SETTLE_WINDOW_MS timeout, so a resize the user causes later can
 * never clobber their viewport — that guarantee is what the old
 * "a visible mount never arms" rule bought, and it is preserved here by
 * closing the window rather than by never watching at all.
 */
export function resolveCanvasRefit(
  state: CanvasRefitState,
  width: number,
  height: number,
): { state: CanvasRefitState; refit: boolean } {
  const degenerate = width <= 0 || height <= 0
  switch (state.phase) {
    case 'pending':
      return degenerate
        ? { state: { phase: 'awaiting-size', size: null }, refit: false }
        : { state: { phase: 'watching-settle', size: { width, height } }, refit: false }
    case 'awaiting-size':
      return degenerate
        ? { state, refit: false }
        : { state: { phase: 'settled', size: null }, refit: true }
    case 'watching-settle': {
      // A degenerate size mid-watch means the pane was hidden again; keep the
      // baseline and wait rather than burning the one refit on a zero box.
      if (degenerate) return { state, refit: false }
      const prev = state.size
      if (prev !== null && prev.width === width && prev.height === height) {
        return { state, refit: false }
      }
      return { state: { phase: 'settled', size: null }, refit: true }
    }
    case 'settled':
      return { state, refit: false }
  }
}

/** Close the window early — the user took the viewport, or it timed out. */
export function settleCanvasRefit(state: CanvasRefitState): CanvasRefitState {
  return state.phase === 'settled' ? state : { phase: 'settled', size: null }
}

interface PortInventory {
  inputs: string[]
  outputs: string[]
}

export function computePorts(
  node: WorkflowNode,
  agentByName: Map<string, Agent>,
  definition: WorkflowDefinition,
  // RFC-243 §5.2 — optional child-workflow resolver; only call-workflow
  // nodes consult it. Omitting it (legacy call sites/tests) keeps the exact
  // pre-RFC-243 declaration: the node declares no ports and edge-derived
  // fallbacks still render whatever edges exist.
  workflowByRef?: WorkflowByRef,
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
  const declared = declaredPorts(
    node,
    definition,
    agentByName,
    workflowByRef === undefined ? undefined : { workflowByRef },
  )
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
  // RFC-243: child-workflow resolver threaded into computePorts so
  // call-workflow nodes render their child-mirrored port rows.
  workflowByRef?: WorkflowByRef,
  // RFC-245: per call-node click target. APPENDED (not inserted after
  // clarifyNavs) because every caller — including nine test files — passes these
  // positionally; inserting would silently reinterpret their arguments.
  callNavs?: Record<string, CallNodeNavKind>,
): Node[] {
  const loopBodyIds = new Set<string>()
  for (const n of definition.nodes) {
    if (n.kind !== 'wrapper-loop') continue
    const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
    if (Array.isArray(inner)) for (const id of inner) loopBodyIds.add(id)
  }
  return definition.nodes.map((n, idx) => {
    const ports = computePorts(n, agentByName, definition, workflowByRef)
    const data: CanvasNodeData = {
      surface,
      nodeId: n.id,
      kind: n.kind,
      title: nodeTitle(n, agentByName),
      inputPorts: ports.inputs,
      outputPorts: ports.outputs,
    }
    if (n.kind === 'agent-single') {
      const agentName = nodeAgentDisplayName(n, agentByName)
      if (agentName.length > 0) data.agentName = agentName
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
    // RFC-245: mark a call node's click target so the card can render the
    // "click to open the child task" hint + pointer cursor. Only the two call
    // kinds present in `callNavs` get it; absent ⇒ not clickable AND (design D1)
    // no drawer fallback. Undefined map (editor canvas) ⇒ no call node ever gets
    // it (golden-lock).
    if (callNavs !== undefined && (n.kind === 'call-workflow' || n.kind === 'call-workgroup')) {
      const nav = callNavs[n.id]
      if (nav !== undefined) data.callNav = nav
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
        if (sourceNode !== undefined) {
          reviewData.inputSourceTitle = nodeTitle(sourceNode, agentByName)
        }
      }
    }
    if (n.kind === 'call-workflow') {
      // RFC-243: surface the referenced workflow name onto node data so
      // CallWorkflowNode can show "which workflow does this call" inside the
      // card body without re-reading the definition.
      const ref = (n as unknown as { workflowName?: unknown }).workflowName
      if (typeof ref === 'string' && ref.length > 0) {
        ;(data as CanvasNodeData & { workflowName?: string }).workflowName = ref
      }
    }
    if (n.kind === 'call-workgroup') {
      // RFC-243 PR-4: same reference chrome for the workgroup twin — surface
      // the referenced workgroup name onto node data for CallWorkgroupNode.
      const ref = (n as unknown as { workgroupName?: unknown }).workgroupName
      if (typeof ref === 'string' && ref.length > 0) {
        ;(data as CanvasNodeData & { workgroupName?: string }).workgroupName = ref
      }
    }
    if (n.kind === 'script') {
      // RFC-253 AC-31: ScriptNode owns the presentation, while this projection
      // remains the single place where definition fields become canvas data.
      // Omitting this bridge left the shared card shell with a literal "—"
      // language chip and no dependency / safety state, so the new node read as
      // an empty legacy outlier even though its definition was fully populated.
      const rec = n as unknown as Record<string, unknown>
      const scriptData = data as ScriptNodeData
      if (typeof rec.language === 'string' && rec.language.length > 0) {
        scriptData.language = rec.language
      }
      scriptData.dependencyCount = Array.isArray(rec.dependencies) ? rec.dependencies.length : 0
      scriptData.networkDenied = rec.network === 'deny'
      scriptData.scriptReadonly = rec.readonly === true
    }
    // RFC-269: surface provider / action / method / support state on the card so
    // an author can tell "merges an MR" from "reads a diff" without opening the
    // drawer. `destructive` describes the configured request, not the broader
    // allowDestructive permission (a GET with that gate enabled is still a GET).
    if (n.kind === 'code-host-call') {
      const rec = n as unknown as Record<string, unknown>
      const callData = data as CodeHostCallNodeData
      if (typeof rec.provider === 'string') callData.provider = rec.provider
      if (typeof rec.action === 'string') callData.action = rec.action
      const provider = rec.provider === 'github' || rec.provider === 'gitlab' ? rec.provider : null
      if (provider !== null && isCodeHostAction(rec.action)) {
        if (rec.action === 'custom') {
          const request =
            rec.request !== null && typeof rec.request === 'object' && !Array.isArray(rec.request)
              ? (rec.request as Record<string, unknown>)
              : {}
          const method =
            typeof request.method === 'string' &&
            (CODE_HOST_METHODS as readonly string[]).includes(request.method)
              ? request.method
              : 'GET'
          callData.method = method
          callData.destructive = method === 'DELETE'
        } else {
          const binding = CODE_HOST_ACTION_DEFS[rec.action].bindings[provider]
          if (isUnsupportedBinding(binding)) callData.unsupported = true
          else callData.method = binding.method
        }
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

/**
 * RFC-270 — 画布上的特权节点保护，纯函数两只。
 *
 * 「不可拖」不是装饰：drag-stop 会按几何重算 wrapper 归属并改写 `nodeIds`，而
 * 归属在两个 author 门的敏感投影里 —— 一次纯粹的挪位置就会变成 403。「不可删」
 * 与「边不可删」同理：删节点、拆入边都会改变敏感投影。三者一起，无权限用户在
 * 画布上就没有任何一条能触发 `script-author-forbidden` 的路径。
 *
 * `protectedIds` 为空时返回同一个引用，让 memo 的下游不必重算。
 */
export function lockPrivilegedFlowNodes(nodes: Node[], protectedIds: ReadonlySet<string>): Node[] {
  if (protectedIds.size === 0) return nodes
  return nodes.map((node) =>
    protectedIds.has(node.id) ? { ...node, draggable: false, deletable: false } : node,
  )
}

/**
 * INBOUND edges only, and that boundary is the gate's, not a guess.
 *
 * `inboundEdgeSignature` filters `edge.target.nodeId === nodeId`, so only an
 * edge POINTING AT a privileged node is in its sensitive projection. An edge
 * leaving one feeds some downstream node's inputs — if that node is itself
 * privileged the target rule already covers it, and if it is not, rewiring it
 * is ordinary editing the gate has always allowed. Locking both directions
 * would take away a capability `proposal.md §5 C6` never claimed ("入边不可改")
 * and the backend would happily have accepted.
 */
export function lockPrivilegedFlowEdges(edges: Edge[], protectedIds: ReadonlySet<string>): Edge[] {
  if (protectedIds.size === 0) return edges
  return edges.map((edge) => (protectedIds.has(edge.target) ? { ...edge, deletable: false } : edge))
}

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
    /** Omitted by legacy tests/callers; only an explicit false suppresses it. */
    showInlineActions?: boolean
  },
  validationCounts?: Readonly<Record<string, WorkflowValidationCounts | undefined>>,
): Edge[] {
  const onInsertNode =
    edgeInsertion !== undefined &&
    canShowEdgeInsertAffordance(
      edgeInsertion.surface,
      edgeInsertion.readOnly,
      edgeInsertion.hasChangeHandler,
    ) &&
    edgeInsertion.showInlineActions !== false
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
  // RFC-243: child-workflow resolver so call-workflow port threading is
  // testable the same way the other data slots are.
  workflowByRef?: WorkflowByRef,
  // RFC-245: call-node click targets. Appended last for the same reason the
  // production signature appends it — existing tests pass through position 13.
  callNavs?: Record<string, CallNodeNavKind>,
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
    workflowByRef,
    callNavs,
  )
}
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
export const __testComputePorts = computePorts
export const __testAffectsDefinition = affectsDefinition
export const __testSameIds = sameIds
