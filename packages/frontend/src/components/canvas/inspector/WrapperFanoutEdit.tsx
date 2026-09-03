// RFC-060 — wrapper-fanout inspector. Extracted verbatim from the
// NodeInspector EditForm switch by RFC-146 T3.
//
// RFC-354 (schema v6): the fan-out's PARAMETERS are its inbound edges (any
// target port name is a broadcast parameter, exactly like an agent's inputs)
// and the one node-level fact left is `shardSourcePort` — which parameter's
// items are split into shards. The rows below are read straight off
// `definition.edges`; the shard source is chosen among them. Inner nodeIds[]
// stay read-only (managed via canvas drag); outputs[] are derived from the
// inner aggregator agent (or the implicit __done__ signal).

import type { WorkflowNode } from '@agent-workflow/shared'
import { buildNodeAgentLookup, deriveWrapperFanoutOutputs } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { Select } from '@/components/Select'
import { readShardSourcePort } from '../../../lib/workflow-connection-plan'
import { nodeTitle } from '../nodeTitle'
import { atomicNodeInspectorChange, type InspectorChangeMeta } from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import { InspectorFieldAnchor, InspectorPortAnchor } from './InspectorFieldAnchor'
import type { EditProps } from './types'

export function WrapperFanoutEdit({
  node,
  agents,
  definition,
  onPatch,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped inner nodes resolve by id.
  const agentLookup = buildNodeAgentLookup(agents, (a) => a)
  const parameterEdges = definition.edges.filter(
    (edge) => edge.target.nodeId === node.id && edge.boundary === undefined,
  )
  const parameterNames: string[] = []
  for (const edge of parameterEdges) {
    if (!parameterNames.includes(edge.target.portName)) parameterNames.push(edge.target.portName)
  }
  const handoffs = definition.edges.filter(
    (edge) => edge.boundary === 'wrapper-input' && edge.source.nodeId === node.id,
  )
  const shardSourcePort = readShardSourcePort(node) ?? ''
  const shardUnfed = shardSourcePort !== '' && !parameterNames.includes(shardSourcePort)
  const derivedOutputs = deriveWrapperFanoutOutputs(definition, node.id, agentLookup)
  function update(patch: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch(
      {
        ...(node as Record<string, unknown>),
        ...patch,
      } as unknown as WorkflowNode,
      meta,
    )
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
        <div className="muted">
          {inner.length === 0 ? t('inspector.none') : inner.map((i) => <code key={i}>{i} </code>)}
        </div>
      </Field>
      <Field label={t('inspector.fanoutParams')} hint={t('inspector.fanoutParamsHint')}>
        <div className="fanout-inputs-list" data-testid="fanout-parameter-list">
          {parameterNames.length === 0 ? (
            <span className="muted">{t('inspector.fanoutParamsNone')}</span>
          ) : (
            parameterNames.map((name) => (
              <InspectorPortAnchor
                key={name}
                nodeId={node.id}
                direction="input"
                portName={name}
                className="fanout-input-row-wrap"
              >
                <div className="fanout-input-wired">
                  <code>{name}</code>
                  {name === shardSourcePort ? (
                    <span className="canvas-node__port-tag canvas-node__port-tag--shard">
                      {t('wrapperNode.shardSourceTagShort')}
                    </span>
                  ) : null}
                  {parameterEdges
                    .filter((edge) => edge.target.portName === name)
                    .map((edge) => {
                      const sourceNode = definition.nodes.find(
                        (candidate) => candidate.id === edge.source.nodeId,
                      )
                      return (
                        <span key={edge.id} className="fanout-input-wired__src">
                          ←{' '}
                          <code title={edge.source.nodeId}>
                            {sourceNode === undefined
                              ? edge.source.nodeId
                              : nodeTitle(sourceNode, agentLookup, definition)}
                          </code>
                          <span>.</span>
                          <code>{edge.source.portName}</code>
                        </span>
                      )
                    })}
                  {handoffs
                    .filter((handoff) => handoff.source.portName === name)
                    .map((handoff) => (
                      <span key={handoff.id} className="fanout-input-wired__src">
                        → <code>{handoff.target.nodeId}</code>
                        <span>.</span>
                        <code>{handoff.target.portName}</code>
                      </span>
                    ))}
                </div>
              </InspectorPortAnchor>
            ))
          )}
        </div>
      </Field>
      <InspectorFieldAnchor nodeId={node.id} field="fanout-inputs">
        <Field
          label={t('inspector.fanoutShardSourcePort')}
          hint={t('inspector.fanoutShardSourcePortHint')}
          required
        >
          <Select<string>
            className={shardUnfed ? 'form-input--invalid' : undefined}
            value={shardSourcePort}
            ariaLabel={t('inspector.fanoutShardSourcePort')}
            data-testid="fanout-shard-source-select"
            onChange={(next) =>
              update(
                { shardSourcePort: next },
                atomicNodeInspectorChange(
                  node.id,
                  'shardSourcePort',
                  t('inspector.fanoutShardSourcePort'),
                ),
              )
            }
            options={[
              ...parameterNames.map((name) => ({ value: name, label: name })),
              ...(shardUnfed
                ? [
                    {
                      value: shardSourcePort,
                      label: t('inspector.missingOption', { value: shardSourcePort }),
                    },
                  ]
                : []),
            ]}
          />
          {shardUnfed ? (
            <div className="form-input__error">
              {t('inspector.fanoutShardSourceUnfed', { port: shardSourcePort })}
            </div>
          ) : null}
        </Field>
      </InspectorFieldAnchor>
      <Field
        label={t('inspector.fanoutDerivedOutputs')}
        hint={t('inspector.fanoutDerivedOutputsHint')}
      >
        <div className="muted">
          {derivedOutputs.map((o) => (
            <div key={o.name}>
              <code>{o.name}</code>
              <span> : </span>
              <code>{o.kind}</code>
            </div>
          ))}
        </div>
      </Field>
    </div>
  )
}
