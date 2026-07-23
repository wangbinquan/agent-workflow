// agent-single inspector branch — agentName + promptTemplate with resolved
// inbound port chips + missing-{{ref}} diagnostics. Extracted verbatim from
// the NodeInspector EditForm switch by RFC-146 T3.
//
// (RFC-113 moved model/variant/temperature to the runtime; RFC-115 moved
// retries/timeout to global config — the node carries no execution-param
// overrides anymore. RFC-060 PR-E removed agent-multi; fan-out work goes
// through wrapper-fanout, which has its own inspector component.)

import type { WorkflowNode } from '@agent-workflow/shared'
import { buildNodeAgentLookup } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextArea } from '@/components/Form'
import { Select } from '@/components/Select'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import { computePorts } from '../WorkflowCanvas'
import { MissingRefList, PortRefList } from './promptRefs'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import type { EditProps } from './types'

export function AgentSingleEdit({
  node,
  agents,
  definition,
  onPatch,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : ''
  const promptTemplate = typeof rec.promptTemplate === 'string' ? rec.promptTemplate : ''
  const owners = useUserLookup(agents.map((agent) => agent.ownerUserId))
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const ports = computePorts(
    node,
    buildNodeAgentLookup(agents, (a) => a),
    definition,
  )

  function update(p: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch({ ...(node as Record<string, unknown>), ...p } as unknown as WorkflowNode, meta)
  }

  const promptMeta = continuousNodeInspectorChange(
    node.id,
    'promptTemplate',
    t('inspector.fieldPromptTemplate'),
  )

  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <InspectorFieldAnchor nodeId={node.id} field="agent">
        <Field label={t('inspector.fieldAgent')} required>
          <Select<string>
            value={agentId}
            placeholder={t('inspector.pickAgent')}
            ariaLabel={t('inspector.fieldAgent')}
            searchable
            onChange={(v) => {
              // RFC-223 (PR-2): stamp the canonical agentId beside agentName so
              // the runtime dispatches by id (rename-safe). Always overwrite it
              // (undefined when cleared) so a re-pick never leaves a stale id.
              const selected = agents.find((agent) => agent.id === v)
              update(
                { agentName: selected?.name ?? '', agentId: selected?.id },
                atomicNodeInspectorChange(node.id, 'agentName', t('inspector.fieldAgent')),
              )
            }}
            options={[
              { value: '', label: t('inspector.pickAgent') },
              ...agents.map((agent) => ({
                value: agent.id,
                label: resourceOptionLabel(
                  agent.name,
                  owners.get(agent.ownerUserId)?.displayName ?? agent.ownerUserId ?? undefined,
                ),
              })),
            ]}
          />
        </Field>
      </InspectorFieldAnchor>

      <InspectorFieldAnchor nodeId={node.id} field="prompt">
        <Field
          label={t('inspector.fieldPromptTemplate')}
          hint={t('inspector.fieldPromptTemplateHint')}
        >
          <InspectorHistoryBoundary meta={promptMeta} onBoundary={onHistoryBoundary}>
            <TextArea
              value={promptTemplate}
              onChange={(v) => update({ promptTemplate: v }, promptMeta)}
              rows={8}
              monospace
            />
          </InspectorHistoryBoundary>
          <PortRefList ports={ports.inputs} />
          <MissingRefList template={promptTemplate} inputPorts={ports.inputs} />
        </Field>
      </InspectorFieldAnchor>
      {/* RFC-115: per-node retries + timeout overrides removed — both are
          now global execution policy (config.defaultNodeRetries /
          defaultPerNodeTimeoutMs), set in Settings → Limits. */}
    </div>
  )
}
