// output-node inspector branch (RFC-007 form↔edge sync) — extracted verbatim
// from the NodeInspector EditForm switch by RFC-146 T3.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { syncEdgeFromFormField } from '../connectionSync'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function OutputEdit({ node, definition, onPatch, onCommitDef }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const ports = Array.isArray(rec.ports)
    ? (rec.ports as Array<{ name: string; bind: { nodeId: string; portName: string } }>)
    : []
  // RFC-007: setPorts now mirrors the bind / rename / add / remove
  // operations into definition.edges via syncEdgeFromFormField, so
  // typing into the bind fields produces the same canvas edge that a
  // drag-to-connect would have.
  function setPorts(next: typeof ports) {
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
    onCommitDef(def)
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field label={t('inspector.fieldOutputPorts')} hint={t('inspector.fieldOutputPortsHint')}>
        <ul className="inspector__output-ports">
          {ports.map((p, i) => (
            <li key={i} className="inspector__output-port-row">
              <input
                className="form-input"
                value={p.name}
                onChange={(e) => {
                  const copy = [...ports]
                  copy[i] = { ...p, name: e.target.value }
                  setPorts(copy)
                }}
                placeholder={t('inspector.portNamePlaceholder')}
              />
              <input
                className="form-input form-input--mono"
                value={p.bind.nodeId}
                onChange={(e) => {
                  const copy = [...ports]
                  copy[i] = { ...p, bind: { ...p.bind, nodeId: e.target.value } }
                  setPorts(copy)
                }}
                placeholder={t('inspector.upstreamPlaceholder')}
              />
              <input
                className="form-input form-input--mono"
                value={p.bind.portName}
                onChange={(e) => {
                  const copy = [...ports]
                  copy[i] = { ...p, bind: { ...p.bind, portName: e.target.value } }
                  setPorts(copy)
                }}
                placeholder={t('inspector.portPlaceholder')}
              />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPorts(ports.filter((_, j) => j !== i))}
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
            setPorts([
              ...ports,
              { name: `port_${ports.length + 1}`, bind: { nodeId: '', portName: '' } },
            ])
          }
        >
          {t('inspector.addPort')}
        </button>
      </Field>
    </div>
  )
}
