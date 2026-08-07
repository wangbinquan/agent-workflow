// RFC-106 T3 — live new-or-reuse preview INJECTOR.
//
// While a connection is dragged over an open named-input target node (agent,
// workgroup call, script or output; never the source), this resolves whether
// the drop will create a NEW
// input (the default) or REUSE an existing one (a precise drop onto an existing
// input handle), and injects that into the node's data so PortHandles renders
// it: a real preview port row for `new`, or a highlight on the existing port row
// for `reuse`. The custom connection line ends on the same resolved handle, so
// the in-flight line === the released edge.
//
// It hit-tests the drag pointer against node bounds itself (findNewInputTarget,
// via resolveDropTarget) rather than reading xyflow's `connection.toNode` (only
// set when the pointer is on a handle). Renders nothing; all effect is through
// node data via the canvas's setNodes (onPreviewChange). Pairs with
// WorkflowCanvas.handleConnect / onConnectEnd, which build the same edge.

import { useEffect } from 'react'
import { useConnection, useReactFlow } from '@xyflow/react'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { getNodeBoxes, resolveDropTarget } from './connectResolve'

export interface ConnectPreviewTarget {
  nodeId: string
  kind: 'new' | 'reuse'
  port: string
}

export interface ConnectHintLabels {
  newInput: string
  reuseInput: string
}

export function ConnectDropHint({
  definition,
  labels,
  pointerRef,
  onPreviewChange,
}: {
  definition: WorkflowDefinition
  labels: ConnectHintLabels
  /** Latest CLIENT pointer (px) during the drag, tracked by the canvas. Used for
   *  the precise-reuse check (vs handle getBoundingClientRect, also client px) —
   *  it is the RAW cursor, whereas `connection.to` is snapped to the catch-all. */
  pointerRef: { current: { x: number; y: number } | null }
  /** Stable callback into the canvas to inject/clear the preview (the canvas
   *  owns `nodes` state, so it does the setNodes). */
  onPreviewChange: (target: ConnectPreviewTarget | null) => void
}) {
  const connection = useConnection()
  const rf = useReactFlow()

  let nodeId: string | null = null
  let kind: 'new' | 'reuse' | null = null
  let port: string | null = null
  // Only preview drags that START from a SOURCE (output) handle. A reverse drag
  // from a target/input handle is not honored on release (handleConnectEnd bails
  // on non-source), so a New/Reuse preview for it would break preview === release
  // (Codex P2).
  const fromSource = connection?.inProgress === true && connection.fromHandle?.type === 'source'
  const sourceNodeId = fromSource ? connection.fromNode?.id : undefined
  const sourceHandle = fromSource ? connection.fromHandle?.id : undefined
  // COORDINATE SPACES (verified against @xyflow/react index.js storeSelector$1):
  // `useConnection().to` is FLOW coords — the selector converts the raw screen
  // point via pointToRendererPoint(to, transform), so it is transform-aware
  // (correct after any fitView / pan / zoom) and drives the node hit-test. Its
  // sibling `connection.pointer` is NOT converted (raw screen) — do not use it as
  // flow. The precise-reuse probe instead needs the RAW cursor in CLIENT px
  // (pointerRef, tracked by the canvas) compared to each handle's
  // getBoundingClientRect; `to` is additionally snapped to the catch-all so it
  // must not be the reuse probe.
  const flowPoint = fromSource ? connection.to : undefined
  const clientPoint = pointerRef.current
  if (sourceNodeId != null && sourceHandle != null && flowPoint != null) {
    const screenPoint = clientPoint ?? rf.flowToScreenPosition(flowPoint)
    const resolved = resolveDropTarget(
      definition,
      getNodeBoxes(rf),
      flowPoint,
      screenPoint,
      sourceNodeId,
      sourceHandle,
    )
    if (resolved !== null) {
      nodeId = resolved.nodeId
      kind = resolved.kind
      port = resolved.portName
    }
  }

  // Fire only when the resolved target changes (primitive deps). The canvas's
  // setNodes is a no-op when nothing changed, so a redundant call is cheap.
  useEffect(() => {
    onPreviewChange(
      nodeId !== null && kind !== null && port !== null ? { nodeId, kind, port } : null,
    )
  }, [nodeId, kind, port, onPreviewChange])

  // Clear any lingering preview when the canvas unmounts.
  useEffect(() => () => onPreviewChange(null), [onPreviewChange])

  // Floating badge that explicitly names the outcome (NEW vs REUSE) + the port,
  // so reuse is unmistakable and the author won't wire it by accident. Follows
  // the raw cursor (client px), falling back to the flow point in screen space.
  if (kind === null || port === null || flowPoint == null) return null
  const tip = clientPoint ?? rf.flowToScreenPosition(flowPoint)
  const reuse = kind === 'reuse'
  return (
    <div
      className={`canvas-connect-badge canvas-connect-badge--${reuse ? 'reuse' : 'new'}`}
      style={{ position: 'fixed', left: tip.x + 14, top: tip.y - 10 }}
      data-testid="canvas-connect-badge"
    >
      {`${reuse ? labels.reuseInput : labels.newInput} · ${port}`}
    </div>
  )
}
