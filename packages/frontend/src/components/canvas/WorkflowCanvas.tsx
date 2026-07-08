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
  type OnConnectEnd,
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
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import type {
  Agent,
  ClarifyDirective,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@agent-workflow/shared'
import { declaredPorts, isClarifyAskingNode, isWrapperKind } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { AgentNode } from './nodes/AgentNode'
import { applyPaste, buildSlice, getClipboard, setClipboard } from './canvasClipboard'
import {
  applyClarifyReverseDrag,
  cascadeRemoveClarifyChannel,
  classifyClarifyConnection,
  clarifyHasAttachedAgent,
  clearClarifyEdgesForRemovedNodes,
  hasExistingClarifyChannel,
  isValidClarifyTarget,
} from './clarifyDragHelper'
import {
  applyCrossClarifyDesignerDrag,
  applyCrossClarifyQuestionerReverseDrag,
  cascadeRemoveCrossClarifyChannel,
  classifyCrossClarifyConnection,
  clearCrossClarifyEdgesForRemovedNodes,
  crossClarifyHasAttachedQuestioner,
  crossClarifyHasDesignerEdge,
  isStrayClarifyChannelDrop,
  isValidCrossClarifyQuestioner,
  questionerHasExistingClarifyChannel,
} from './crossClarifyDragHelper'
import { existingInputPorts, nextFreeInputPort } from './dropTarget'
import { getNodeBoxes, resolveDropTarget } from './connectResolve'
import { buildControlFlowEdgeIds, CONTROL_FLOW_EDGE_CLASS } from './controlFlowEdge'
import { ConnectDropHint, type ConnectPreviewTarget } from './ConnectDropHint'
import { ClarifyNode } from './nodes/ClarifyNode'
import { CrossClarifyNode } from './nodes/CrossClarifyNode'
import { applyConnectionForReviewOutput, applyDisconnectForReviewOutput } from './connectionSync'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { InputNode } from './nodes/InputNode'
import { deserialize, makeNode, PALETTE_MIME } from './nodePalette'
import { OutputNode } from './nodes/OutputNode'
import { ReviewNode } from './nodes/ReviewNode'
import { INBOUND_HANDLE_ID, type CanvasNodeData, type CanvasSelection } from './nodes/types'
import { syncInputDefs } from './syncInputDefs'
import { GroupWrapperNode } from './nodes/WrapperNodes'
import {
  buildMeasuredSizesFromXyflowNodes,
  projectDefinitionForXyflow,
  projectXyflowPositionsToAbsolute,
} from './coordProjection'
import {
  applyMembershipPatch,
  resolveMembershipOnDragStop,
  type WrapperHitInput,
} from './wrapperMembership'
import { DEFAULT_NODE_SIZE_BY_KIND, fitWrapperToInner } from './wrapperFit'
import { clearWrapperSize, deleteWrapperWithChildren } from './wrapperOps'

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
}

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition
  /** Used to look up agent.outputs when rendering agent nodes. Optional. */
  agents?: Agent[]
  onChange?: (next: WorkflowDefinition) => void
  /**
   * Receives the currently-selected node or edge, or null when nothing
   * (or a multi-selection) is active. Edge selection lets the editor
   * route render an EdgeInspector instead of a NodeInspector (RFC-003).
   */
  onSelect?: (sel: CanvasSelection | null) => void
  readOnly?: boolean
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
  clearSelection: () => void
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
  definition,
  agents,
  onChange,
  onSelect,
  readOnly,
  nodeStatuses,
  taskContext,
  questionCounts,
  onNodeQuestionBadgeClick,
  clarifyDirectives,
  onNodeClarifyDirectiveToggle,
  handleRef,
}: WorkflowCanvasProps & {
  handleRef?: React.ForwardedRef<WorkflowCanvasHandle>
}) {
  const { t } = useTranslation()
  const agentByName = useMemo(() => {
    const m = new Map<string, Agent>()
    for (const a of agents ?? []) m.set(a.name, a)
    return m
  }, [agents])
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
  // RFC-004: every definition commit funnels through `commitChange`, which
  // reconciles `definition.inputs[]` with input-node inputKeys. Adding /
  // patching / deleting input nodes therefore keeps the launcher form
  // declaration in lock-step automatically.
  //
  // RFC-007: the same chokepoint detects edges that were present in the
  // prior `definition` but are missing from `next`, and clears the matching
  // `inputSource` / `port.bind` field on review / output nodes. This
  // covers all three deletion paths (Delete key, EdgeInspector remove,
  // node-removal cascade) without each callsite having to opt in.
  const commitChange = useCallback(
    (next: WorkflowDefinition) => {
      if (onChange === undefined) return
      const nextEdgeIds = new Set(next.edges.map((e) => e.id))
      const deleted = definition.edges.filter((e) => !nextEdgeIds.has(e.id))
      let staged = deleted.length === 0 ? next : applyDisconnectForReviewOutput(next, deleted)
      // RFC-023 bugfix: a clarify channel is a (ask, ans) pair persisted as
      // two edges. Deleting either half on its own would leave a half-wired
      // channel — the scheduler still sees the ask edge and re-runs the
      // clarify cycle, but the canvas no longer shows the answer arrow.
      // Cascade-remove the sibling so a single-edge delete cleanly tears
      // down the whole channel.
      if (deleted.length > 0) {
        staged = cascadeRemoveClarifyChannel(staged, deleted)
        // RFC-056 mirror of the RFC-023 cascade: deleting one half of the
        // cross-clarify ask/ans pair on its own would leave a half-wired
        // questioner channel. Sweep the sibling so single-edge delete
        // cleanly tears down the channel. The `designer` half is a single
        // edge with no sibling and is intentionally not cascaded here.
        staged = cascadeRemoveCrossClarifyChannel(staged, deleted)
      }
      const synced = syncInputDefs(staged.inputs ?? [], staged.nodes)
      if (synced !== (staged.inputs ?? [])) staged = { ...staged, inputs: synced }
      onChange(staged)
    },
    [definition.edges, onChange],
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
  const wrapperRef = useRef<HTMLDivElement | null>(null)
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
      ),
    ),
  )
  const [edges, setEdges] = useState<Edge[]>(() =>
    toFlowEdges(definition.edges, buildControlFlowEdgeIds(definition, agentByName)),
  )
  const externalDefRef = useRef(definition)
  const externalStatusesRef = useRef(nodeStatuses)
  // RFC-120 D13: mirror of `nodeStatuses`' externalStatusesRef guard — lets the
  // def-sync useEffect rebuild node data when only `questionCounts` changes
  // (badge counts arrive async from the questions query, definition unchanged).
  const externalQuestionCountsRef = useRef(questionCounts)
  // RFC-122: mirror of the questionCounts ref-guard so a directives-only change
  // (toggle POST resolves, definition unchanged) repaints the toggles.
  const externalClarifyDirectivesRef = useRef(clarifyDirectives)
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

  useEffect(() => {
    const defChanged = definition !== externalDefRef.current
    const statusChanged = nodeStatuses !== externalStatusesRef.current
    const agentsChanged = agentByName !== externalAgentsRef.current
    // RFC-120 D13: question-badge counts also drive a node-data rebuild — same
    // ref-guard shape as `statusChanged` so a counts-only change repaints badges.
    const questionsChanged = questionCounts !== externalQuestionCountsRef.current
    // RFC-122: directive map change repaints the toggles (same ref-guard shape).
    const directivesChanged = clarifyDirectives !== externalClarifyDirectivesRef.current
    if (defChanged || statusChanged || agentsChanged || questionsChanged || directivesChanged) {
      externalDefRef.current = definition
      externalStatusesRef.current = nodeStatuses
      externalAgentsRef.current = agentByName
      externalQuestionCountsRef.current = questionCounts
      externalClarifyDirectivesRef.current = clarifyDirectives
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
      if (defChanged || agentsChanged)
        setEdges(
          applySelection(
            toFlowEdges(definition.edges, buildControlFlowEdgeIds(definition, agentByName)),
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
  ])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => {
        const next = applyNodeChanges(changes, prev)
        if (!readOnly && onChange !== undefined) {
          // Only propagate changes that actually affect the persisted
          // workflow definition. xyflow's `select` and `dimensions`
          // changes are local UI state — propagating them would mint a
          // new definition reference, which the def-sync useEffect would
          // immediately re-apply by rebuilding `nodes`, retriggering
          // onNodesChange... a feedback loop that hits React's
          // "Maximum update depth exceeded" guard.
          if (affectsDefinition(changes)) {
            const stillReferenced = new Set(next.map((n) => n.id))
            const liveEdges = edges.filter(
              (e) => stillReferenced.has(e.source) && stillReferenced.has(e.target),
            )
            if (liveEdges.length !== edges.length) setEdges(liveEdges)
            const removedIds: string[] = []
            for (const c of changes) {
              if (c.type === 'remove') removedIds.push(c.id)
            }
            commitChange(toDefinition(definition, next, liveEdges))
            // Delete key path: xyflow's built-in `deleteKeyCode` removes the
            // selected node before our `deleteSelected` callback ever fires
            // (deleteSelected is wired only to the right-click menu). Without
            // this branch the parent route still has `selection={kind:'node',
            // id:<deleted>}`, the inspector returns null but the 3rd grid
            // column stays open → an empty white frame on the right until
            // the user clicks elsewhere. Mirror onPaneClick's "clear parent
            // selection" path whenever an emitted-selection node is among
            // the removed ids. The internal `selection` ref's nodes/edges
            // are kept in sync separately via the onSelectionChange handler.
            if (removedIds.length > 0) {
              const sig = lastEmittedSelectionSig.current
              const emittedNodeMatch = sig.startsWith('node:') && removedIds.includes(sig.slice(5))
              if (emittedNodeMatch && onSelect !== undefined) {
                lastEmittedSelectionSig.current = 'null'
                onSelect(null)
              }
            }
          }
        }
        return next
      })
    },
    [commitChange, definition, edges, onChange, onSelect, readOnly],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly === true) return
      setEdges((prev) => {
        // Apply ALL change types (select / remove / replace / etc) via
        // xyflow's helper. Previous version only handled `remove`, which
        // silently swallowed `select` changes — edges never got
        // `selected: true`, the EdgeInspector entry point was unreachable.
        const next = applyEdgeChanges(changes, prev)
        // Only the structural mutations need to round-trip into the
        // persisted WorkflowDefinition; selection-only ticks stay local.
        if (onChange !== undefined && affectsEdgeDefinition(changes)) {
          const removedIds: string[] = []
          for (const c of changes) {
            if (c.type === 'remove') removedIds.push(c.id)
          }
          commitChange(toDefinition(definition, nodes, next))
          // Same parent-selection clear as handleNodesChange: xyflow's
          // built-in Delete-key path also removes the selected edge here,
          // not via deleteSelected. Without this, the parent route's
          // selection still references the dead edge and the inspector
          // column stays open.
          if (removedIds.length > 0) {
            const sig = lastEmittedSelectionSig.current
            const emittedEdgeMatch = sig.startsWith('edge:') && removedIds.includes(sig.slice(5))
            if (emittedEdgeMatch && onSelect !== undefined) {
              lastEmittedSelectionSig.current = 'null'
              onSelect(null)
            }
          }
        }
        return next
      })
    },
    [commitChange, definition, nodes, onChange, onSelect, readOnly],
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
      // RFC-023 clarify-channel drops (both directions). The pure classifier
      // recognises:
      //   - reverse drag: drag FROM clarify.questions input handle TO an
      //     agent output port (xyflow normalises to source=agent,
      //     target=clarify, targetHandle='questions').
      //   - forward drag: drag FROM clarify.answers output handle TO any
      //     agent input handle (source=clarify, sourceHandle='answers').
      // Both produce the same two-edge clarify channel via
      // applyClarifyReverseDrag — the user gets the same outcome
      // regardless of drag direction. Without this branch the forward
      // drag would create a stray `clarify.answers → agent.<input>` edge
      // that the runtime ignores (channel detection keys off the agent's
      // `__clarify__` outbound edge).
      const clarifyDrop = classifyClarifyConnection(definition, conn)
      if (clarifyDrop !== null) {
        const next = applyClarifyReverseDrag(definition, {
          sourceAgentNodeId: clarifyDrop.sourceAgentNodeId,
          clarifyNodeId: clarifyDrop.clarifyNodeId,
        })
        if (next !== definition) commitChange(next)
        return
      }
      // RFC-056 cross-clarify drops. Two shapes:
      //   - questioner-reverse: reverse-drag onto cross.questions → 2 edges
      //     (questioner.__clarify__ → cross.questions /
      //      cross.to_questioner → questioner.__clarify_response__).
      //   - designer-forward: forward-drag cross.to_designer → designer →
      //     1 edge with target on the synthetic __external_feedback__ port.
      const crossDrop = classifyCrossClarifyConnection(definition, conn)
      if (crossDrop !== null) {
        let next = definition
        if (crossDrop.kind === 'questioner-reverse') {
          next = applyCrossClarifyQuestionerReverseDrag(definition, {
            questionerNodeId: crossDrop.questionerNodeId,
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
          })
        } else {
          next = applyCrossClarifyDesignerDrag(definition, {
            crossClarifyNodeId: crossDrop.crossClarifyNodeId,
            designerNodeId: crossDrop.designerNodeId,
          })
        }
        if (next !== definition) commitChange(next)
        return
      }
      // RFC-007: distinguish "dropped on catch-all left strip" from "dropped
      // on a specific named handle" BEFORE translateInboundConnection rewrites
      // targetHandle.
      let viaCatchAll = conn.targetHandle === INBOUND_HANDLE_ID
      let translated = translateInboundConnection(conn)
      let reusePort: string | null = null
      // RFC-106: a catch-all drop on an agent-single / output target ALWAYS
      // allocates a NEW input whose name is deconflicted against this node's
      // existing inputs (`nextFreeInputPort`), so two upstreams both exposing
      // `result` land on `result` / `result_2` instead of colliding on one
      // `result`. We key off the KNOWN target node (`conn.target`), not the
      // cursor hit-test — the catch-all strip overhangs the node edge, so a drop
      // on its outside sliver leaves the pointer outside node bounds yet is still
      // a valid new input here (Codex P2). The pointer only decides the precise
      // REUSE override (drop landed on an existing port of THIS node). Channels /
      // review / wrappers fall through to the legacy path untouched.
      const targetNode =
        conn.targetHandle === INBOUND_HANDLE_ID
          ? definition.nodes.find((n) => n.id === conn.target)
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
          const screenPt = connectPointer.current
          const resolved = resolveDropTarget(
            definition,
            getNodeBoxes(rf),
            rf.screenToFlowPosition(screenPt),
            screenPt,
            conn.source,
            conn.sourceHandle,
          )
          if (resolved !== null && resolved.nodeId === conn.target && resolved.kind === 'reuse') {
            portName = resolved.portName
            reusePort = portName
          }
        }
        translated = { ...conn, targetHandle: portName }
        viaCatchAll = reusePort === null
      }
      const builtRaw = buildEdgeFromConnection(definition, translated)
      if (builtRaw === null) return
      // A reuse drop overwrites that input's source — drop any prior edge into it.
      const baseDef =
        reusePort !== null
          ? {
              ...definition,
              edges: definition.edges.filter(
                (e) =>
                  !(e.target.nodeId === builtRaw.target.nodeId && e.target.portName === reusePort),
              ),
            }
          : definition
      // RFC-060 §3 — tag wrapper-fanout boundary edges so the scheduler /
      // aggregator paths pick them up. The two helpers are mutually exclusive,
      // so chaining them is safe.
      const built = markBoundaryWrapperOutput(baseDef, markBoundaryWrapperInput(baseDef, builtRaw))
      const withEdge = { ...baseDef, edges: [...baseDef.edges, built] }
      const synced = applyConnectionForReviewOutput(withEdge, built, { viaCatchAll })
      // RFC-060 — wrapper-fanout inputs[] is the single source of truth for
      // declared ports. If the user dragged an edge that lands on a port
      // name not in inputs[], auto-append it so the inspector and the
      // canvas stay in sync (without this, the canvas shows the wired
      // handle but the inspector's inputs[] list is missing the entry, and
      // the validator would emit a port-mismatch on next save).
      const reconciled = ensureWrapperFanoutInputForEdge(synced, built)
      commitChange(reconciled)
    },
    [commitChange, definition, onChange, readOnly, rf],
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
      const built0: WorkflowEdge = {
        id: `edge_${ulid().slice(-6).toLowerCase()}`,
        source: { nodeId: src, portName: srcH },
        target: { nodeId: target.nodeId, portName: target.portName },
      }
      // A reuse drop overwrites that port's source — drop any prior edge into it.
      const baseEdges =
        target.kind === 'reuse'
          ? definition.edges.filter(
              (e) => !(e.target.nodeId === target.nodeId && e.target.portName === target.portName),
            )
          : definition.edges
      const built = markBoundaryWrapperOutput(
        { ...definition, edges: baseEdges },
        markBoundaryWrapperInput({ ...definition, edges: baseEdges }, built0),
      )
      const withEdge = { ...definition, edges: [...baseEdges, built] }
      const synced = applyConnectionForReviewOutput(withEdge, built, {
        viaCatchAll: target.kind === 'new',
      })
      const reconciled = ensureWrapperFanoutInputForEdge(synced, built)
      commitChange(reconciled)
    },
    [commitChange, definition, onChange, readOnly, rf, trackConnectPointer],
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
      // xyflow types `Edge.targetHandle` as `string | undefined`, so
      // normalise to `string | null` before passing to the classifiers.
      const guardConn = {
        source: conn.source ?? null,
        target: conn.target ?? null,
        sourceHandle: conn.sourceHandle ?? null,
        targetHandle: conn.targetHandle ?? null,
      }
      // RFC-023: clarify-channel pre-flight for both reverse + forward
      // drags. Fail fast on self-loops, non-agent counterparts, or an
      // agent that already has another clarify wired. xyflow respects the
      // false return by showing a red dashed line + refusing to fire
      // onConnect. When `null`, this connection is not a clarify drop and
      // falls through to the regular validity checks below.
      const clarifyDrop = classifyClarifyConnection(definition, guardConn)
      if (clarifyDrop !== null) {
        if (clarifyDrop.sourceAgentNodeId === clarifyDrop.clarifyNodeId) return false
        const agent = definition.nodes.find((n) => n.id === clarifyDrop.sourceAgentNodeId)
        if (!isValidClarifyTarget(agent)) return false
        if (hasExistingClarifyChannel(definition, clarifyDrop.sourceAgentNodeId)) return false
        // RFC-063: a single clarify node may attach to at most one agent.
        // Block the second-agent reverse-drag with the same red-dashed UX
        // that already covers the inverse direction.
        if (clarifyHasAttachedAgent(definition, clarifyDrop.clarifyNodeId)) return false
        return true
      }
      // RFC-056 cross-clarify pre-flight. Must run BEFORE the merged
      // defensive guard below — cross-clarify reuses the literal port name
      // `'questions'` (===CLARIFY_INPUT_PORT_NAME), so a defensive
      // RFC-023 guard placed ahead of this classifier would silently
      // reject every cross-clarify questioner-reverse drop (see issue #2
      // 2026-05-22 UI bug report). Mirrors the RFC-023 path: fail-fast on
      // self-loops, non-agent-single counterparts, and already-wired
      // channels. xyflow draws the red dashed reject UI on `return false`.
      const crossDrop = classifyCrossClarifyConnection(definition, guardConn)
      if (crossDrop !== null) {
        if (crossDrop.kind === 'questioner-reverse') {
          if (crossDrop.questionerNodeId === crossDrop.crossClarifyNodeId) return false
          const q = definition.nodes.find((n) => n.id === crossDrop.questionerNodeId)
          if (!isValidCrossClarifyQuestioner(q)) return false
          if (questionerHasExistingClarifyChannel(definition, crossDrop.questionerNodeId))
            return false
          // RFC-063: one cross-clarify node may attach to at most one
          // questioner. Block a second-questioner reverse-drag with the
          // same red-dashed UX that already covers the inverse direction.
          if (crossClarifyHasAttachedQuestioner(definition, crossDrop.crossClarifyNodeId))
            return false
          return true
        }
        // designer-forward
        if (crossDrop.crossClarifyNodeId === crossDrop.designerNodeId) return false
        const d = definition.nodes.find((n) => n.id === crossDrop.designerNodeId)
        if (d === undefined || d.kind !== 'agent-single') return false
        if (crossClarifyHasDesignerEdge(definition, crossDrop.crossClarifyNodeId)) return false
        return true
      }
      // Merged defensive guard for BOTH RFC-023 + RFC-056 clarify-channel
      // system port handles. Runs only AFTER both classifiers had a chance
      // to match; if a drop is still carrying any channel handle name, it's a
      // stray drop the generic catch-all path would turn into a junk edge that
      // buildScopeUpstreams silently strips (→ false dispatch root) — reject
      // up-front so xyflow shows the red dashed feedback. The handle name list
      // (incl. `__clarify_response__` + `__clarify__`, the false-root incident
      // ports) lives in the pure `isStrayClarifyChannelDrop` so it is
      // unit-testable and stays symmetric.
      if (isStrayClarifyChannelDrop(guardConn)) {
        return false
      }
      // RFC-007 task-detail iterate lock.
      if (taskContext === undefined) return true
      if (conn.target === null || conn.target === undefined) return true
      const node = definition.nodes.find((n) => n.id === conn.target)
      if (node === undefined || node.kind !== 'review') return true
      const iter = taskContext.reviewIteration[conn.target] ?? 0
      return iter === 0
    },
    [definition, taskContext],
  )

  // ---- Clipboard / shortcuts (P-2-07) ----

  const copySelection = useCallback(() => {
    if (selection.nodes.length === 0) return
    const slice = buildSlice(definition, selection.nodes)
    if (slice !== null) setClipboard(slice)
  }, [definition, selection.nodes])

  const pasteFromClipboard = useCallback(
    (at: { x: number; y: number }) => {
      const slice = getClipboard()
      if (slice === null || onChange === undefined || readOnly === true) return
      const { definition: next, newNodeIds } = applyPaste(definition, slice, at)
      commitChange(next)
      setSelection({ nodes: newNodeIds, edges: [] })
    },
    [commitChange, definition, onChange, readOnly],
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
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'c' || e.key === 'C') {
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
  }, [copySelection, pasteFromClipboard, readOnly, rf, selectAll])

  const deleteSelected = useCallback(() => {
    if (onChange === undefined || readOnly === true) return
    if (selection.nodes.length === 0 && selection.edges.length === 0) return
    const removedNodes = new Set(selection.nodes)
    const removedEdges = new Set(selection.edges)
    const keptNodes = definition.nodes.filter((n) => !removedNodes.has(n.id))
    const stillIds = new Set(keptNodes.map((n) => n.id))
    const keptEdges = definition.edges.filter(
      (e) =>
        !removedEdges.has(e.id) && stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
    )
    let nextDef: WorkflowDefinition = { ...definition, nodes: keptNodes, edges: keptEdges }
    // RFC-023: deleting an agent or clarify node cascade-removes both edges
    // of its clarify channel so the canvas doesn't render dangling arrows.
    // (Above filter already drops edges whose endpoint nodes were removed,
    // but routing through the helper documents the dependency.)
    nextDef = clearClarifyEdgesForRemovedNodes(nextDef, [...removedNodes])
    // RFC-056: same cascade for cross-clarify nodes — drops any of the
    // three edge half-shapes (ask / ans / designer) that referenced a
    // removed node.
    nextDef = clearCrossClarifyEdgesForRemovedNodes(nextDef, [...removedNodes])
    commitChange(nextDef)
    setSelection({ nodes: [], edges: [] })
    // Tell the parent route to drop its selection too — otherwise
    // `editorLayoutClass` keeps the third column slot reserved and the
    // (now-empty) NodeInspector renders an empty white frame until the
    // user clicks elsewhere. mirrors onPaneClick's "clear parent
    // selection" path so the inspector folds away the moment its node
    // disappears.
    if (lastEmittedSelectionSig.current !== 'null') {
      lastEmittedSelectionSig.current = 'null'
      if (onSelect !== undefined) onSelect(null)
    }
  }, [commitChange, definition, onChange, onSelect, readOnly, selection.edges, selection.nodes])

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const slice = buildSlice(definition, [nodeId])
      if (slice === null || onChange === undefined || readOnly === true) return
      const at = { x: slice.anchor.x + 40, y: slice.anchor.y + 40 }
      const { definition: next, newNodeIds } = applyPaste(definition, slice, at)
      commitChange(next)
      setSelection({ nodes: newNodeIds, edges: [] })
    },
    [commitChange, definition, onChange, readOnly],
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
      const innerNodes = definition.nodes.filter((n) => innerSet.has(n.id))
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      for (const n of innerNodes) {
        const p = n.position ?? { x: 0, y: 0 }
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
      commitChange({
        ...definition,
        nodes: [...definition.nodes, wrapper as WorkflowNode],
      })
      setSelection({ nodes: [wrapperId], edges: [] })
    },
    [commitChange, definition, onChange, readOnly, selection.nodes],
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
      commitChange({
        ...definition,
        nodes: definition.nodes.filter((n) => n.id !== wrapperId),
      })
      setSelection({ nodes: innerIds, edges: [] })
    },
    [commitChange, definition, onChange, readOnly],
  )

  // RFC-016 T8: Fit to children — closure around the pure clearWrapperSize
  // transformation. The next onNodeDragStop / commitChange cycle writes the
  // recomputed bbox back to wrapper.size.
  const fitWrapperToChildren = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const next = clearWrapperSize(definition, wrapperId)
      if (next !== definition) commitChange(next)
    },
    [commitChange, definition, onChange, readOnly],
  )

  // RFC-016 T8: delete a wrapper AND its inner nodes (right-click menu).
  // Differs from `Unwrap` (decomposeWrapper) which only removes the wrapper
  // and keeps the inner nodes on the canvas. Caller is responsible for the
  // user-facing confirm dialog.
  const deleteWrapperWithInner = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const next = deleteWrapperWithChildren(definition, wrapperId)
      if (next === definition) return
      commitChange(next)
      setSelection({ nodes: [], edges: [] })
    },
    [commitChange, definition, onChange, readOnly],
  )

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
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const existingIds = new Set(definition.nodes.map((n) => n.id))
    const newNode = makeNode(item, pos, { agents, existingIds })
    commitChange({ ...definition, nodes: [...definition.nodes, newNode] })
  }

  function handleNodeContextMenu(e: React.MouseEvent, node: Node) {
    if (readOnly === true) return
    e.preventDefault()
    e.stopPropagation()
    const box = wrapperRef.current?.getBoundingClientRect()
    const x = box === undefined ? e.clientX : e.clientX - box.left
    const y = box === undefined ? e.clientY : e.clientY - box.top
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
    return [
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
          const w = definition.nodes.find((n) => n.id === menu.nodeId)
          if (w === undefined) return
          const inner = (w as Record<string, unknown>).nodeIds
          const count = Array.isArray(inner) ? inner.length : 0
          const ok = window.confirm(t('wrapperNode.confirmDeleteWithInner', { count }))
          if (ok) deleteWrapperWithInner(menu.nodeId)
        },
      },
      { label: t('common.delete'), danger: true, onSelect: deleteSelected },
    ]
  }, [
    copySelection,
    decomposeWrapper,
    definition,
    deleteSelected,
    deleteWrapperWithInner,
    duplicateNode,
    fitWrapperToChildren,
    menu,
    pasteFromClipboard,
    rf,
    selectAll,
    selection.nodes.length,
    t,
    wrapSelection,
  ])

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
      clearSelection: () => {
        storeApi.getState().unselectNodesAndEdges()
        setSelection((prev) =>
          prev.nodes.length === 0 && prev.edges.length === 0 ? prev : { nodes: [], edges: [] },
        )
        lastEmittedSelectionSig.current = 'null'
      },
    }),
    [storeApi],
  )

  return (
    <div
      ref={wrapperRef}
      className="workflow-canvas"
      tabIndex={0}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
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
            // the same path. Wrapper-on-itself is excluded inside resolve().
            if (isWrapperKind(dn.type)) continue
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
          commitChange(nextDef)
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

const FALLBACK_X = (idx: number) => 80 + (idx % 4) * 280
const FALLBACK_Y = (idx: number) => 80 + Math.floor(idx / 4) * 200

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
): Node[] {
  const loopBodyIds = new Set<string>()
  for (const n of definition.nodes) {
    if (n.kind !== 'wrapper-loop') continue
    const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
    if (Array.isArray(inner)) for (const id of inner) loopBodyIds.add(id)
  }
  return definition.nodes.map((n, idx) => {
    const pos = n.position
    const ports = computePorts(n, agentByName, definition)
    const data: CanvasNodeData = {
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
    if (loopBodyIds.has(n.id)) data.loopBody = true
    if (isWrapperKind(n.kind)) {
      const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
      ;(data as CanvasNodeData & { innerCount?: number }).innerCount = inner?.length ?? 0
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
        ;(
          data as CanvasNodeData & { inputSource?: { nodeId: string; portName: string } }
        ).inputSource = { nodeId, portName }
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
      position:
        pos !== undefined ? { x: pos.x, y: pos.y } : { x: FALLBACK_X(idx), y: FALLBACK_Y(idx) },
      data,
    }
  })
}

export function nodeTitle(n: WorkflowNode): string {
  const rec = n as unknown as Record<string, unknown>
  // User-set display name always wins. `review` / `clarify` historically
  // wrote `title` directly; agent-* and other kinds opt in via the
  // Inspector's "display name" field. Empty string falls back to the
  // kind-specific derivation so blanking the input doesn't strand the
  // card with no label.
  if (typeof rec.title === 'string' && rec.title.length > 0) {
    return rec.title
  }
  if (n.kind === 'agent-single') {
    return typeof rec.agentName === 'string' ? rec.agentName : i18n.t('editor.nodeTitleUnsetAgent')
  }
  if (n.kind === 'input') {
    return typeof rec.inputKey === 'string' ? rec.inputKey : i18n.t('editor.nodeTitleUnsetKey')
  }
  return n.id
}

function toFlowEdges(
  defEdges: WorkflowDefinition['edges'],
  controlFlowEdgeIds?: ReadonlySet<string>,
): Edge[] {
  return defEdges.map((e) => ({
    id: e.id,
    source: e.source.nodeId,
    target: e.target.nodeId,
    sourceHandle: e.source.portName,
    targetHandle: e.target.portName,
    // RFC-060 signal ports carry no data — render their edge as a grey dashed
    // control-flow line (styles.css `.canvas-edge--control`). Absent set ⇒ no
    // tagging, so the existing unit-test call sites round-trip unchanged.
    ...(controlFlowEdgeIds?.has(e.id) ? { className: CONTROL_FLOW_EDGE_CLASS } : {}),
  }))
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

/**
 * RFC-060 — when an edge is dropped on a wrapper-fanout target whose port
 * name is not (yet) in the wrapper's `inputs[]`, auto-append the port. The
 * inspector's Inputs list is the single source of truth for wrapper-fanout
 * declared ports — without this reconciliation, drag-creating an inbound
 * edge would create a "phantom" port that's visible on the canvas but
 * missing from the declared list (and would trip the validator on next
 * save).
 *
 * Default kind for the auto-added port:
 *   - If the wrapper currently has no shardSource, mark the new port as
 *     shardSource with kind `list<string>` (it's the most common drop —
 *     authors first wire up the iteration source, then add broadcast
 *     ports later via the inspector).
 *   - Otherwise, add a non-shard port with kind `string`.
 *
 * Returns `prev` by reference when no change is needed so React effects
 * short-circuit on `===`.
 */
/**
 * RFC-060 §3 — tag an edge whose source is a wrapper-fanout node and whose
 * target lives inside that wrapper's `nodeIds[]` as a
 * `boundary: 'wrapper-input'` edge. The scheduler's fanout dispatcher
 * (services/fanout.ts) keys off this flag to inject shards / broadcast
 * values into inner-node prompts; an untagged edge would render on the
 * canvas but be ignored at runtime.
 *
 * Returns `edge` by reference when no tagging is needed.
 */
export function markBoundaryWrapperInput(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const source = def.nodes.find((n) => n.id === edge.source.nodeId)
  if (source === undefined || source.kind !== 'wrapper-fanout') return edge
  const innerIds = (source as Record<string, unknown>).nodeIds
  const memberIds = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  if (!memberIds.includes(edge.target.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-input' }
}

/**
 * RFC-060 §3 — symmetric mirror of {@link markBoundaryWrapperInput}.
 * Tags an edge whose target is a wrapper-fanout node and whose source
 * lives inside that wrapper's `nodeIds[]` as a
 * `boundary: 'wrapper-output'` edge. The runtime aggregator path
 * (services/fanout.ts) treats inner-to-wrapper-output edges as
 * promotions of the aggregator's per-shard outputs to the wrapper's
 * outlet; without this tag the edge would render but the runtime
 * would treat it as a non-boundary edge and refuse to project.
 *
 * Returns `edge` by reference when no tagging is needed.
 */
export function markBoundaryWrapperOutput(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const target = def.nodes.find((n) => n.id === edge.target.nodeId)
  if (target === undefined || target.kind !== 'wrapper-fanout') return edge
  const innerIds = (target as Record<string, unknown>).nodeIds
  const memberIds = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  if (!memberIds.includes(edge.source.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-output' }
}

export function ensureWrapperFanoutInputForEdge(
  prev: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowDefinition {
  const target = prev.nodes.find((n) => n.id === edge.target.nodeId)
  if (target === undefined || target.kind !== 'wrapper-fanout') return prev
  const rec = target as unknown as Record<string, unknown>
  const inputs = Array.isArray(rec.inputs)
    ? (rec.inputs as Array<{ name?: unknown; kind?: unknown; isShardSource?: unknown }>)
    : []
  if (inputs.some((p) => p.name === edge.target.portName)) return prev
  const hasShardSource = inputs.some((p) => p.isShardSource === true)
  const newPort = hasShardSource
    ? { name: edge.target.portName, kind: 'string' }
    : { name: edge.target.portName, kind: 'list<string>', isShardSource: true }
  const nextNodes = prev.nodes.map((n) => {
    if (n.id !== edge.target.nodeId) return n
    return {
      ...(n as Record<string, unknown>),
      inputs: [...inputs, newPort],
    } as unknown as WorkflowNode
  })
  return { ...prev, nodes: nextNodes }
}

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
): Node[] => {
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: defNodes,
    edges,
  }
  const map = new Map<string, Agent>()
  for (const a of agents) map.set(a.name, a)
  return toFlowNodes(
    def,
    map,
    statuses,
    questionCounts,
    onQuestionBadgeClick,
    clarifyDirectives,
    onClarifyDirectiveToggle,
  )
}
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
export const __testComputePorts = computePorts
export const __testAffectsDefinition = affectsDefinition
export const __testSameIds = sameIds
