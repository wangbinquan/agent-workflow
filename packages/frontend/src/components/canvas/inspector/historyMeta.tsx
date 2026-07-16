// RFC-199 T7.3 — semantic history metadata emitted by inspector fields.
//
// Continuous controls (text, textarea, number) share a stable mergeKey for
// node/edge + field and emit a no-op blur boundary. The route stamps time and
// maps this structural subset directly to WorkflowDraftChangeMeta.

import type { ReactNode } from 'react'

export interface InspectorChangeMeta {
  source: 'inspector'
  label: string
  mergeKey?: string
  transaction?: 'single' | 'begin' | 'update' | 'commit'
  historyBoundary?: 'blur' | 'focus-boundary'
}

export function continuousNodeInspectorChange(
  nodeId: string,
  field: string,
  label: string,
): InspectorChangeMeta {
  return {
    source: 'inspector',
    label,
    mergeKey: `node:${nodeId}:${field}`,
    transaction: 'update',
  }
}

export function atomicNodeInspectorChange(
  nodeId: string,
  field: string,
  label: string,
): InspectorChangeMeta {
  return {
    source: 'inspector',
    label,
    transaction: 'single',
  }
}

export function continuousEdgeInspectorChange(
  edgeId: string,
  field: string,
  label: string,
): InspectorChangeMeta {
  return {
    source: 'inspector',
    label,
    mergeKey: `edge:${edgeId}:${field}`,
    transaction: 'update',
  }
}

export function atomicEdgeInspectorChange(
  edgeId: string,
  field: string,
  label: string,
): InspectorChangeMeta {
  return {
    source: 'inspector',
    label,
    transaction: 'single',
  }
}

export function blurInspectorChange(meta: InspectorChangeMeta): InspectorChangeMeta {
  return { ...meta, historyBoundary: 'blur' }
}

/**
 * Form primitives intentionally stay history-agnostic. `display: contents`
 * gives their native blur event a semantic boundary without adding layout
 * chrome or changing the shared primitive API.
 */
export function InspectorHistoryBoundary({
  meta,
  onBoundary,
  children,
}: {
  meta: InspectorChangeMeta
  onBoundary: (meta: InspectorChangeMeta) => void
  children: ReactNode
}) {
  return (
    <span style={{ display: 'contents' }} onBlur={() => onBoundary(blurInspectorChange(meta))}>
      {children}
    </span>
  )
}
