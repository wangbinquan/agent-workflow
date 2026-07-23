// Right-side drawer pane for editing a single canvas edge.
//
// Per design (proposal §3.5 / §4.2 / §4.3 + design.md:510), the edge's
// `target.portName` is what determines the input port a downstream agent
// sees. The default at drop time is `source.portName` (RFC-003); this
// pane lets users rename it later — covering the YAML example
// `in_1.out → worker_1.requirement` without falling back to YAML import.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { buildNodeAgentLookup } from '@agent-workflow/shared'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Select } from '@/components/Select'
import { atomicEdgeInspectorChange, type InspectorChangeMeta } from './inspector/historyMeta'
import { copyText } from '@/lib/clipboard'
import { createWorkflowSemanticContext } from '@/lib/workflow-connection-plan'
import { applyWorkflowTransition, isEdgeTargetPortRenameable } from '@/lib/workflow-transition'
import {
  focusWorkflowInspectorAnchor,
  WORKFLOW_EDGE_INSPECTOR_HEADING_ID,
} from '@/lib/workflow-inspector-target'
import { computePorts } from './WorkflowCanvas'
import { nodeTitle } from './nodeTitle'

export type { InspectorChangeMeta } from './inspector/historyMeta'

export interface EdgeInspectorProps {
  edge: WorkflowEdge
  definition: WorkflowDefinition
  agents?: Agent[]
  focusRequest?: { requestId: number; focusId: string } | null
  onReconnect?: (edgeId: string, trigger: HTMLElement) => void
  onChange: (next: WorkflowDefinition, meta: InspectorChangeMeta) => void
  onClose: () => void
  chrome?: 'rail' | 'content'
}

export function EdgeInspector({
  edge,
  definition,
  agents,
  focusRequest,
  onReconnect,
  onChange,
  onClose,
  chrome = 'rail',
}: EdgeInspectorProps) {
  const { t } = useTranslation()
  const semanticContext = useMemo(() => createWorkflowSemanticContext(agents ?? []), [agents])
  const targetPortRenameable = isEdgeTargetPortRenameable(definition, edge, semanticContext)
  const [conflict, setConflict] = useState<string | null>(null)
  const sourceNode = definition.nodes.find((node) => node.id === edge.source.nodeId)
  const targetNode = definition.nodes.find((node) => node.id === edge.target.nodeId)
  const targetPortOptions =
    targetNode === undefined
      ? [edge.target.portName]
      : Array.from(
          new Set([
            ...computePorts(
              targetNode,
              // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
              buildNodeAgentLookup(agents ?? [], (a) => a),
              definition,
            ).inputs,
            // Keep a legacy or temporarily-invalid persisted value visible.
            // The selector must not guess a replacement before the user makes
            // an explicit choice.
            edge.target.portName,
          ]),
        )

  // Reset draft when xyflow swaps the selection to a different edge.
  useEffect(() => {
    setConflict(null)
  }, [edge.id, edge.target.portName])

  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined) return
    const frame = window.requestAnimationFrame(() => {
      focusWorkflowInspectorAnchor(focusRequest.focusId)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequest])

  function commit(nextPortName: string) {
    if (nextPortName === '' || nextPortName === edge.target.portName) return
    if (hasConflict(definition, edge, nextPortName)) {
      setConflict(t('inspector.edgeConflictMsg'))
      return
    }
    setConflict(null)
    const result = applyWorkflowTransition(
      definition,
      { kind: 'rename-edge-target-port', edgeId: edge.id, portName: nextPortName },
      semanticContext,
    )
    if (result.next === definition && result.warnings.length > 0) {
      setConflict(t('inspector.edgeConflictMsg'))
      return
    }
    onChange(
      result.next,
      atomicEdgeInspectorChange(edge.id, 'target.portName', t('inspector.edgePortNameLabel')),
    )
  }

  function remove() {
    const result = applyWorkflowTransition(
      definition,
      { kind: 'delete-selection', nodeIds: [], edgeIds: [edge.id] },
      semanticContext,
    )
    onChange(
      result.next,
      atomicEdgeInspectorChange(edge.id, 'delete', t('inspector.edgeDeleteBtn')),
    )
    onClose()
  }

  return (
    <div
      className={chrome === 'rail' ? 'inspector' : 'inspector-content'}
      data-inspector-content="edge"
    >
      {chrome === 'rail' ? (
        <header className="inspector__header">
          <div>
            <div id={WORKFLOW_EDGE_INSPECTOR_HEADING_ID} className="inspector__kind" tabIndex={-1}>
              {t('inspector.edgeTitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inspector__close"
            aria-label={t('inspector.closeAria')}
          >
            ×
          </button>
        </header>
      ) : (
        <div id={WORKFLOW_EDGE_INSPECTOR_HEADING_ID} className="sr-only" tabIndex={-1}>
          {t('inspector.edgeTitle')}
        </div>
      )}
      <div className="inspector__body">
        <div className="form-grid">
          <Field label={t('inspector.edgeSourceLabel')}>
            <div className="inspector__readonly">
              <strong>
                {sourceNode === undefined ? edge.source.nodeId : nodeTitle(sourceNode)}
              </strong>
              <span> · {edge.source.portName}</span>
            </div>
          </Field>
          <Field label={t('inspector.edgeTargetLabel')}>
            <div className="inspector__readonly">
              <strong>
                {targetNode === undefined ? edge.target.nodeId : nodeTitle(targetNode)}
              </strong>
            </div>
          </Field>
          <Field label={t('inspector.edgePortNameLabel')}>
            <Select<string>
              searchable
              value={edge.target.portName}
              ariaLabel={t('inspector.edgePortNameLabel')}
              disabled={!targetPortRenameable}
              onChange={commit}
              options={targetPortOptions.map((portName) => ({ value: portName, label: portName }))}
            />
            {!targetPortRenameable && (
              <div className="form-hint">{t('inspector.edgePortFixedHint')}</div>
            )}
            {conflict !== null && <ErrorBanner error={conflict} />}
          </Field>
          {onReconnect !== undefined ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={(event) => onReconnect(edge.id, event.currentTarget)}
            >
              {t('inspector.edgeReconnectBtn')}
            </button>
          ) : null}
          <details className="inspector__technical">
            <summary>{t('agentForm.technicalDetailsSummary')}</summary>
            <dl>
              <dt>{t('inspector.technicalId')}</dt>
              <dd className="inspector__technical-id">
                <code>{edge.id}</code>
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  onClick={() => void copyText(edge.id)}
                >
                  {t('editor.nodeActions.copy')}
                </button>
              </dd>
              <dt>{t('inspector.edgeSourceLabel')}</dt>
              <dd>
                <code>
                  {edge.source.nodeId}.{edge.source.portName}
                </code>
              </dd>
              <dt>{t('inspector.edgeTargetLabel')}</dt>
              <dd>
                <code>
                  {edge.target.nodeId}.{edge.target.portName}
                </code>
              </dd>
            </dl>
          </details>
          <button type="button" className="btn btn--sm btn--danger" onClick={remove}>
            {t('inspector.edgeDeleteBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Returns true if renaming `edge.target.portName` to `next` would collide
 * with an existing edge that has the same (source.nodeId, source.portName,
 * target.nodeId, next portName) tuple — `buildEdgeFromConnection` already
 * rejects exact duplicates at create time, and we mirror that here so a
 * rename can't smuggle one in. Same target.nodeId + same name from a
 * different source is the legitimate fan-in case (proposal §4.2) and not
 * a conflict.
 *
 * Exported for unit tests.
 */
export function hasConflict(def: WorkflowDefinition, edge: WorkflowEdge, next: string): boolean {
  return def.edges.some(
    (e) =>
      e.id !== edge.id &&
      e.source.nodeId === edge.source.nodeId &&
      e.source.portName === edge.source.portName &&
      e.target.nodeId === edge.target.nodeId &&
      e.target.portName === next,
  )
}
