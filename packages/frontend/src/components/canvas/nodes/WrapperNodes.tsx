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

import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'

/** Extra fields the canvas injects beyond the shared CanvasNodeData. */
export interface WrapperNodeData extends CanvasNodeData {
  /** Number of direct inner nodes (for the header pill summary). */
  innerCount?: number
  /** Loop only — surfaced to render the "× N · kind" pill. */
  maxIterations?: number
  exitConditionKind?: 'port-empty' | 'port-not-empty' | 'port-equals' | 'port-count-lt' | string
}

interface Props extends NodeProps {
  data: WrapperNodeData
}

/** Header pill component — shows git "snapshot" or loop iteration summary. */
function WrapperHeaderPill({ data, kind }: { data: WrapperNodeData; kind: 'git' | 'loop' }) {
  const { t } = useTranslation()
  if (kind === 'git') {
    return (
      <span className="wrapper-header-pill wrapper-header-pill--git">
        {t('wrapperNode.pillGit')}
      </span>
    )
  }
  const max = typeof data.maxIterations === 'number' ? data.maxIterations : 1
  const exitKind = data.exitConditionKind ?? 'port-empty'
  return (
    <span className="wrapper-header-pill wrapper-header-pill--loop">
      {t('wrapperNode.pillLoop', { max, kind: exitKind })}
    </span>
  )
}

/** Unified group container component for wrapper-git and wrapper-loop.
 * Branches on data.kind to pick label + icon + whether to render the
 * loop-only catch-all left handle. */
export function GroupWrapperNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const kind: 'git' | 'loop' = data.kind === 'wrapper-loop' ? 'loop' : 'git'
  const label = kind === 'git' ? t('wrapperNode.labelGit') : t('wrapperNode.labelLoop')
  const icon = kind === 'git' ? '⎈' : '⟳'
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
        <WrapperHeaderPill data={data} kind={kind} />
      </div>
      {data.innerCount === 0 ? (
        <div className="canvas-node__wrapper-empty-hint">{t('wrapperNode.dropHere')}</div>
      ) : null}
      {kind === 'loop' ? (
        <PortHandles side="left" ports={[]} catchAll={{ id: INBOUND_HANDLE_ID }} />
      ) : null}
      <PortHandles side="right" ports={data.outputPorts} />
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
