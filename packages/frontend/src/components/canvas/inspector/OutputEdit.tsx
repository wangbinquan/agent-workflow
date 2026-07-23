// output-node inspector branch (RFC-007 form↔edge sync) — extracted verbatim
// from the NodeInspector EditForm switch by RFC-146 T3.

import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { Select } from '@/components/Select'
import { buildNodeAgentLookup } from '@agent-workflow/shared'
import { computePorts } from '../WorkflowCanvas'
import { nodeTitle } from '../nodeTitle'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
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
  const rec = node as unknown as Record<string, unknown>
  const ports = Array.isArray(rec.ports)
    ? (rec.ports as Array<{ name: string; bind: { nodeId: string; portName: string } }>)
    : []
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const agentByName = buildNodeAgentLookup(agents, (a) => a)
  const upstreamCandidates = definition.nodes
    .filter((candidate) => candidate.id !== node.id && candidate.kind !== 'output')
    .map((candidate) => ({
      id: candidate.id,
      title: nodeTitle(candidate),
      ports: computePorts(candidate, agentByName, definition).outputs,
    }))
  // RFC-199: node declarations and matching edges are one typed transition;
  // this form no longer owns a second connection-sync implementation.
  function setPorts(next: typeof ports, meta: InspectorChangeMeta) {
    onTransition({ kind: 'set-output-ports', outputNodeId: node.id, ports: next }, meta)
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <InspectorFieldAnchor nodeId={node.id} field="output-binding">
        <Field label={t('inspector.fieldOutputPorts')} hint={t('inspector.fieldOutputPortsHint')}>
          <ul className="inspector__output-ports">
            {ports.map((p, i) => {
              const selectedNode = upstreamCandidates.find(
                (candidate) => candidate.id === p.bind.nodeId,
              )
              const missingNode = p.bind.nodeId.length > 0 && selectedNode === undefined
              const missingPort =
                p.bind.portName.length > 0 &&
                selectedNode !== undefined &&
                !selectedNode.ports.includes(p.bind.portName)
              return (
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
                  <InspectorPortAnchor
                    nodeId={node.id}
                    direction="input"
                    portName={p.name}
                    className="inspector__output-port-binding"
                  >
                    <Select<string>
                      searchable
                      className={missingNode ? 'form-input--invalid' : undefined}
                      value={p.bind.nodeId}
                      ariaLabel={t('inspector.upstreamPlaceholder')}
                      onChange={(nextNodeId) => {
                        const nextCandidate = upstreamCandidates.find(
                          (candidate) => candidate.id === nextNodeId,
                        )
                        const nextPort =
                          nextCandidate?.ports.includes(p.bind.portName) === true
                            ? p.bind.portName
                            : ''
                        const copy = [...ports]
                        copy[i] = {
                          ...p,
                          bind: { nodeId: nextNodeId, portName: nextPort },
                        }
                        setPorts(
                          copy,
                          atomicNodeInspectorChange(
                            node.id,
                            `ports.${i}.bind.nodeId`,
                            t('inspector.fieldOutputPorts'),
                          ),
                        )
                      }}
                      options={[
                        { value: '', label: t('inspector.upstreamPlaceholder') },
                        ...upstreamCandidates.map((candidate) => ({
                          value: candidate.id,
                          label:
                            candidate.title === candidate.id
                              ? candidate.id
                              : `${candidate.title} (${candidate.id})`,
                        })),
                        ...(missingNode
                          ? [
                              {
                                value: p.bind.nodeId,
                                label: t('inspector.missingOption', { value: p.bind.nodeId }),
                              },
                            ]
                          : []),
                      ]}
                    />
                    <Select<string>
                      searchable
                      className={missingPort ? 'form-input--invalid' : undefined}
                      value={p.bind.portName}
                      ariaLabel={t('inspector.portPlaceholder')}
                      disabled={p.bind.nodeId.length === 0}
                      onChange={(nextPortName) => {
                        const copy = [...ports]
                        copy[i] = { ...p, bind: { ...p.bind, portName: nextPortName } }
                        setPorts(
                          copy,
                          atomicNodeInspectorChange(
                            node.id,
                            `ports.${i}.bind.portName`,
                            t('inspector.fieldOutputPorts'),
                          ),
                        )
                      }}
                      options={[
                        { value: '', label: t('inspector.portPlaceholder') },
                        ...(selectedNode?.ports ?? []).map((portName) => ({
                          value: portName,
                          label: portName,
                        })),
                        ...(missingPort
                          ? [
                              {
                                value: p.bind.portName,
                                label: t('inspector.missingOption', { value: p.bind.portName }),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </InspectorPortAnchor>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      setPorts(
                        ports.filter((_, j) => j !== i),
                        atomicNodeInspectorChange(
                          node.id,
                          `ports.${i}.remove`,
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
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              setPorts(
                [
                  ...ports,
                  { name: `port_${ports.length + 1}`, bind: { nodeId: '', portName: '' } },
                ],
                atomicNodeInspectorChange(node.id, 'ports.add', t('inspector.addPort')),
              )
            }
          >
            {t('inspector.addPort')}
          </button>
        </Field>
      </InspectorFieldAnchor>
    </div>
  )
}
