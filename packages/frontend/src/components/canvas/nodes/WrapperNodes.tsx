// RFC-016: wrapper-git / wrapper-loop are now rendered as a single
// GroupWrapperNode component — a real container rectangle sized by
// wrapper.size (or computeFitBounds when absent) with inner nodes projected
// onto it via xyflow's parentId/extent='parent' contract. The previous
// 240px placeholder cards are gone; visibility of "what belongs to what"
// comes from physical containment, not a labeled chip.
//
// Loop wrappers keep the RFC-003 catch-all inbound handle as a tolerant
// drop target; the legacy named left input ports are removed — they had no
// runtime semantics in scheduler.ts and only misled users.
//
// Wrapper output ports (git_diff for wrapper-git, outputBindings.name[] for
// wrapper-loop) render along the BOTTOM edge, centered. Right-side rendering
// (the shared `<PortHandles side="right">` path used by agent nodes) doesn't
// fit wrappers — the wrapper's `padding: 0` (required so the visible rect
// matches the bbox xyflow uses for child clipping) means the default
// right-handle offset of -14px pushes the dot outside the wrapper. A
// bottom-centered layout also reads more naturally for a container whose
// "output" semantically belongs to the whole group, not a side row.

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'

/** Extra fields the canvas injects beyond the shared CanvasNodeData. */
export interface WrapperNodeData extends CanvasNodeData {
  /** Number of direct inner nodes (for the header pill summary). */
  innerCount?: number
  /** Loop only — kept on the node data so future header/inspector affordances
   * can surface the iteration parameters; the pill itself no longer reads
   * them (it carries a kind label only, parallel to git/fanout). */
  maxIterations?: number
  exitConditionKind?: 'port-empty' | 'port-not-empty' | 'port-equals' | 'port-count-lt' | string
}

interface Props extends NodeProps {
  data: WrapperNodeData
}

/** Header pill — a short kind badge that mirrors the wrapper type
 *  ("snapshot" / "loop" / "fanout"). Parameters like maxIterations + exit
 *  condition show in the Inspector, not the canvas chip — keeping all three
 *  wrapper pills parallel keeps the canvas legible at a glance and avoids
 *  the cryptic "× 3 · port-empty" dump the loop pill used to surface. */
function WrapperHeaderPill({ kind }: { kind: 'git' | 'loop' | 'fanout' }) {
  const { t } = useTranslation()
  const labelKey =
    kind === 'git'
      ? 'wrapperNode.pillGit'
      : kind === 'loop'
        ? 'wrapperNode.pillLoop'
        : 'wrapperNode.pillFanout'
  return <span className={`wrapper-header-pill wrapper-header-pill--${kind}`}>{t(labelKey)}</span>
}

/** Unified group container component for wrapper-git / wrapper-loop /
 *  wrapper-fanout (RFC-060). Branches on data.kind to pick label + icon +
 *  whether to render the loop-only catch-all left handle. */
export function GroupWrapperNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const kind: 'git' | 'loop' | 'fanout' =
    data.kind === 'wrapper-loop' ? 'loop' : data.kind === 'wrapper-fanout' ? 'fanout' : 'git'
  const label =
    kind === 'loop'
      ? t('wrapperNode.labelLoop')
      : kind === 'fanout'
        ? t('wrapperNode.labelFanout')
        : t('wrapperNode.labelGit')
  const icon = kind === 'loop' ? '⟳' : kind === 'fanout' ? '⫶' : '⎈'
  return (
    <div
      className={[
        'canvas-node',
        'canvas-node--wrapper-group',
        `canvas-node--wrapper-group--${kind}`,
        selected ? 'canvas-node--selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {icon} {label}
        </span>
        <WrapperHeaderPill kind={kind} />
      </div>
      {data.innerCount === 0 ? (
        <div className="canvas-node__wrapper-empty-hint">{t('wrapperNode.dropHere')}</div>
      ) : null}
      {kind === 'loop' ? (
        <PortHandles side="left" ports={[]} catchAll={{ id: INBOUND_HANDLE_ID }} />
      ) : null}
      {/* RFC-060 — wrapper-fanout declares `inputs[]` (shardSource +
       *  optional broadcast inputs). Without these target Handles, the
       *  fanout wrapper has no canvas affordance for drag-connect of
       *  upstream edges. The catch-all lets the first drop land on the
       *  shardSource (typical case); precise per-port drops still hit
       *  named handles via z-index priority. */}
      {kind === 'fanout' ? (
        <PortHandles side="left" ports={data.inputPorts} catchAll={{ id: INBOUND_HANDLE_ID }} />
      ) : null}
      {/* Fanout outputs render on the RIGHT (mirrors the agent-node layout
       *  so the wrapper reads as an agent-shaped block at a glance): inputs
       *  on the left, outputs on the right. Each output handle still keeps
       *  the signal-port chrome for `__done__` via the same className
       *  branch as the bottom-port renderer. */}
      {kind === 'fanout' && data.outputPorts.length > 0 ? (
        <div className="canvas-node__port-rows canvas-node__port-rows--right canvas-node__port-rows--wrapper-fanout">
          {data.outputPorts.map((p) => {
            const isSignal = p === '__done__'
            return (
              <div
                key={p}
                className={`canvas-node__port-row canvas-node__port-row--right${isSignal ? ' canvas-node__port-row--signal' : ''}`}
                data-signal={isSignal ? 'true' : undefined}
              >
                <span className="canvas-node__port-label" title={p}>
                  {p}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={p}
                  className={`canvas-node__handle${isSignal ? ' canvas-node__handle--signal' : ''}`}
                />
              </div>
            )
          })}
        </div>
      ) : null}
      {/* git / loop keep bottom-centered outputs (RFC-016 §3.2). The right-
       *  side layout that fanout uses doesn't fit them: wrapper-git's single
       *  `git_diff` output reads better at the bottom because the wrapper is
       *  typically wider than tall, and wrapper-loop's outputBindings are
       *  authored downstream of the loop body, not on a side. */}
      {kind !== 'fanout' && data.outputPorts.length > 0 ? (
        <div className="canvas-node__bottom-ports">
          {data.outputPorts.map((p) => {
            const isSignal = p === '__done__'
            return (
              <div
                key={p}
                className={`canvas-node__bottom-port${isSignal ? ' canvas-node__bottom-port--signal' : ''}`}
                data-signal={isSignal ? 'true' : undefined}
              >
                <span className="canvas-node__port-label" title={p}>
                  {p}
                </span>
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id={p}
                  className={`canvas-node__handle${isSignal ? ' canvas-node__handle--signal' : ''}`}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// Backward-compat exports — WorkflowCanvas may still import GitWrapperNode /
// LoopWrapperNode by name. Both point to the same GroupWrapperNode; the
// nodeTypes registration in WorkflowCanvas.tsx uses GroupWrapperNode
// directly after the integration patch (T6), so these re-exports are kept
// only to avoid a one-line ripple during T5 and will be deleted in T6.
export const GitWrapperNode = GroupWrapperNode
export const LoopWrapperNode = GroupWrapperNode
