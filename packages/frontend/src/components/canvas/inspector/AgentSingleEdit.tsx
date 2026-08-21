// agent-single inspector branch — agentName + promptTemplate with resolved
// inbound port chips + missing-{{ref}} diagnostics. Extracted verbatim from
// the NodeInspector EditForm switch by RFC-146 T3.
//
// (RFC-113 moved model/variant/temperature to the runtime; RFC-115 moved
// retries/timeout to global config — the node carries no execution-param
// overrides anymore. RFC-060 PR-E removed agent-multi; fan-out work goes
// through wrapper-fanout, which has its own inspector component.)

import type { WorkflowNode } from '@agent-workflow/shared'
import { buildNodeAgentLookup, resolveNodeAgent } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { useId, useRef } from 'react'
import { Field, TextArea } from '@/components/Form'
import { RuntimeParameterPicker } from '@/components/RuntimeParameterPicker'
import { buildRuntimeParameterCatalog } from '@/components/runtime-parameters/catalog'
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
import { JoinModeField } from './JoinModeField'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import { ResourceReferenceControl } from './ResourceReferenceControl'
import type { EditProps } from './types'

export function AgentSingleEdit({
  node,
  agents,
  definition,
  triggerContracts,
  onPatch,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : ''
  const promptTemplate = typeof rec.promptTemplate === 'string' ? rec.promptTemplate : ''
  const owners = useUserLookup(agents.map((agent) => agent.ownerUserId))
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const agentLookup = buildNodeAgentLookup(agents, (a) => a)
  const selectedAgent = resolveNodeAgent(node, agentLookup)
  const ports = computePorts(node, agentLookup, definition)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const promptLabelId = useId()

  function update(p: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch({ ...(node as Record<string, unknown>), ...p } as unknown as WorkflowNode, meta)
  }

  const promptMeta = continuousNodeInspectorChange(
    node.id,
    'promptTemplate',
    t('inspector.fieldPromptTemplate'),
  )
  const promptLabel = t('inspector.fieldPromptTemplate')
  const parameterCatalog = buildRuntimeParameterCatalog(
    {
      audience: 'workflow-inspector',
      surface: 'agent-prompt',
      triggerContracts,
      t,
    },
    {
      local: ports.inputs.map((port) => ({
        id: `local:node:${node.id}:input:${port}`,
        source: 'current-node',
        field: port,
        token: `{{${port}}}`,
        label: t('runtimeParameters.localInputLabel', { port }),
        description: t('runtimeParameters.localInputDescription'),
      })),
    },
  )

  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      {/* RFC-306 — only rendered when this node has 2+ inbound dependencies. */}
      <JoinModeField node={node} definition={definition} onPatch={onPatch} />
      <InspectorFieldAnchor nodeId={node.id} field="agent">
        <Field label={t('inspector.fieldAgent')} required group>
          <ResourceReferenceControl
            kind="agent"
            resourceId={selectedAgent?.id}
            resourceName={selectedAgent?.name}
            resourceLabel={t('inspector.fieldAgent')}
            testId="agent-ref-open"
          >
            <Select<string>
              value={agentId}
              placeholder={t('inspector.pickAgent')}
              ariaLabel={t('inspector.fieldAgent')}
              searchable
              onChange={(v) => {
                // RFC-223 PR7: the inspector is another agent-selection writer.
                // Unknown/cleared values must not turn a canonical node back into
                // a persisted name-only draft.
                const selected = agents.find((agent) => agent.id === v)
                if (selected === undefined) return
                update(
                  { agentName: selected.name, agentId: selected.id },
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
          </ResourceReferenceControl>
        </Field>
      </InspectorFieldAnchor>

      <InspectorFieldAnchor nodeId={node.id} field="prompt">
        <Field
          label={promptLabel}
          hint={t('inspector.fieldPromptTemplateHint')}
          group
          labelId={promptLabelId}
          action={
            <RuntimeParameterPicker
              authority="workflow:model-prompt"
              entries={parameterCatalog}
              target={{
                id: `${node.id}:promptTemplate`,
                label: promptLabel,
                mode: 'insert-at-caret',
                value: promptTemplate,
                revision: promptTemplate,
                element: () => promptRef.current,
                commit: (next) =>
                  update(
                    { promptTemplate: next },
                    atomicNodeInspectorChange(node.id, 'promptTemplate', promptLabel),
                  ),
              }}
              testId="agent-runtime-parameter-picker"
            />
          }
        >
          <InspectorHistoryBoundary meta={promptMeta} onBoundary={onHistoryBoundary}>
            <TextArea
              value={promptTemplate}
              onChange={(v) => update({ promptTemplate: v }, promptMeta)}
              rows={8}
              monospace
              textareaRef={promptRef}
              aria-labelledby={promptLabelId}
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
