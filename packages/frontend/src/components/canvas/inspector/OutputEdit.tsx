// output-node inspector branch — extracted from the NodeInspector EditForm
// switch by RFC-146 T3.
//
// RFC-354 (schema v6): an output node declares no ports of its own — each
// inbound edge IS one port (the edge's target port name = the card's name on
// the task detail page, its source = where the value comes from). The rows
// below are read straight off `definition.edges`; a port is created by
// connecting an edge on the canvas and removed by deleting that edge (the
// Remove button here dispatches that deletion through the one transition
// chokepoint). Renaming a port = renaming the edge's target port in the
// EdgeInspector.

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { buildNodeAgentLookup } from '@agent-workflow/shared'
import { nodeTitle } from '../nodeTitle'
import { atomicNodeInspectorChange } from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import { InspectorFieldAnchor, InspectorPortAnchor } from './InspectorFieldAnchor'
import type { EditProps } from './types'

export function OutputEdit({
  node,
  agents,
  definition,
  onPatch,
  onTransition,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const outputPortsLabelId = useId()
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const agentByName = buildNodeAgentLookup(agents, (a) => a)
  const portEdges = definition.edges.filter(
    (edge) => edge.target.nodeId === node.id && edge.boundary !== 'wrapper-output',
  )
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <InspectorFieldAnchor nodeId={node.id} field="output-binding">
        <Field
          label={t('inspector.fieldOutputPorts')}
          hint={t('inspector.fieldOutputPortsHint')}
          group
          labelId={outputPortsLabelId}
        >
          {portEdges.length === 0 ? (
            <div className="muted" data-testid="output-ports-empty">
              {t('inspector.outputPortsNone')}
            </div>
          ) : (
            <ul className="inspector__output-ports" data-testid="output-ports">
              {portEdges.map((edge) => {
                const sourceNode = definition.nodes.find(
                  (candidate) => candidate.id === edge.source.nodeId,
                )
                const sourceTitle =
                  sourceNode === undefined
                    ? edge.source.nodeId
                    : nodeTitle(sourceNode, agentByName, definition)
                return (
                  <li key={edge.id} className="inspector__output-port-row">
                    <InspectorPortAnchor
                      nodeId={node.id}
                      direction="input"
                      portName={edge.target.portName}
                      className="inspector__output-port-binding"
                    >
                      <code>{edge.target.portName}</code>
                      <span className="muted"> ← </span>
                      <code title={edge.source.nodeId}>{sourceTitle}</code>
                      <span className="muted">.</span>
                      <code>{edge.source.portName}</code>
                    </InspectorPortAnchor>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() =>
                        onTransition(
                          { kind: 'delete-selection', nodeIds: [], edgeIds: [edge.id] },
                          atomicNodeInspectorChange(
                            node.id,
                            `ports.${edge.target.portName}.remove`,
                            t('inspector.remove'),
                          ),
                        )
                      }
                    >
                      {t('inspector.remove')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Field>
      </InspectorFieldAnchor>
    </div>
  )
}
