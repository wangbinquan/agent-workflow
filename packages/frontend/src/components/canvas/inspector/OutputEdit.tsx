// output-node inspector branch (RFC-007 form↔edge sync) — extracted verbatim
// from the NodeInspector EditForm switch by RFC-146 T3.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { syncEdgeFromFormField } from '../connectionSync'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function OutputEdit({
  node,
  definition,
  onPatch,
  onCommitDef,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const ports = Array.isArray(rec.ports)
    ? (rec.ports as Array<{ name: string; bind: { nodeId: string; portName: string } }>)
    : []
  // RFC-007: setPorts now mirrors the bind / rename / add / remove
  // operations into definition.edges via syncEdgeFromFormField, so
  // typing into the bind fields produces the same canvas edge that a
  // drag-to-connect would have.
  function setPorts(next: typeof ports, meta: InspectorChangeMeta) {
    const nodes = definition.nodes.map((n) =>
      n.id === node.id
        ? ({
            ...(n as Record<string, unknown>),
            ports: next,
          } as unknown as WorkflowNode)
        : n,
    )
    let def: WorkflowDefinition = { ...definition, nodes }
    const prevByName = new Map(ports.map((p) => [p.name, p]))
    const nextByName = new Map(next.map((p) => [p.name, p]))
    // Removed / renamed-away ports → drop their edge.
    for (const [name, p] of prevByName) {
      if (!nextByName.has(name)) {
        def = syncEdgeFromFormField(def, { nodeId: node.id, portName: name }, p.bind, null)
      }
    }
    // Reconcile bind on every surviving / new port.
    for (const [name, p] of nextByName) {
      const prev = prevByName.get(name)
      const prevBind = prev?.bind ?? null
      const nextBindEmpty = p.bind.nodeId === '' && p.bind.portName === ''
      const nextBind = nextBindEmpty ? null : p.bind
      def = syncEdgeFromFormField(def, { nodeId: node.id, portName: name }, prevBind, nextBind)
    }
    onCommitDef(def, meta)
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <Field label={t('inspector.fieldOutputPorts')} hint={t('inspector.fieldOutputPortsHint')}>
        <ul className="inspector__output-ports">
          {ports.map((p, i) => (
            <li key={i} className="inspector__output-port-row">
              <InspectorHistoryBoundary
                meta={continuousNodeInspectorChange(
                  node.id,
                  `ports.${i}.name`,
                  t('inspector.fieldOutputPorts'),
                )}
                onBoundary={onHistoryBoundary}
              >
                <input
                  className="form-input"
                  value={p.name}
                  onChange={(e) => {
                    const copy = [...ports]
                    copy[i] = { ...p, name: e.target.value }
                    setPorts(
                      copy,
                      continuousNodeInspectorChange(
                        node.id,
                        `ports.${i}.name`,
                        t('inspector.fieldOutputPorts'),
                      ),
                    )
                  }}
                  placeholder={t('inspector.portNamePlaceholder')}
                />
              </InspectorHistoryBoundary>
              <InspectorHistoryBoundary
                meta={continuousNodeInspectorChange(
                  node.id,
                  `ports.${i}.bind.nodeId`,
                  t('inspector.fieldOutputPorts'),
                )}
                onBoundary={onHistoryBoundary}
              >
                <input
                  className="form-input form-input--mono"
                  value={p.bind.nodeId}
                  onChange={(e) => {
                    const copy = [...ports]
                    copy[i] = { ...p, bind: { ...p.bind, nodeId: e.target.value } }
                    setPorts(
                      copy,
                      continuousNodeInspectorChange(
                        node.id,
                        `ports.${i}.bind.nodeId`,
                        t('inspector.fieldOutputPorts'),
                      ),
                    )
                  }}
                  placeholder={t('inspector.upstreamPlaceholder')}
                />
              </InspectorHistoryBoundary>
              <InspectorHistoryBoundary
                meta={continuousNodeInspectorChange(
                  node.id,
                  `ports.${i}.bind.portName`,
                  t('inspector.fieldOutputPorts'),
                )}
                onBoundary={onHistoryBoundary}
              >
                <input
                  className="form-input form-input--mono"
                  value={p.bind.portName}
                  onChange={(e) => {
                    const copy = [...ports]
                    copy[i] = { ...p, bind: { ...p.bind, portName: e.target.value } }
                    setPorts(
                      copy,
                      continuousNodeInspectorChange(
                        node.id,
                        `ports.${i}.bind.portName`,
                        t('inspector.fieldOutputPorts'),
                      ),
                    )
                  }}
                  placeholder={t('inspector.portPlaceholder')}
                />
              </InspectorHistoryBoundary>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  setPorts(
                    ports.filter((_, j) => j !== i),
                    atomicNodeInspectorChange(node.id, `ports.${i}.remove`, t('inspector.remove')),
                  )
                }
              >
                {t('inspector.remove')}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            setPorts(
              [...ports, { name: `port_${ports.length + 1}`, bind: { nodeId: '', portName: '' } }],
              atomicNodeInspectorChange(node.id, 'ports.add', t('inspector.addPort')),
            )
          }
        >
          {t('inspector.addPort')}
        </button>
      </Field>
    </div>
  )
}
