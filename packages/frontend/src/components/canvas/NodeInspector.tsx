// Right-side 480px inspector drawer. Opens when the canvas reports a
// selected node; closes when the selection clears. Two tabs: Edit (form)
// and Preview (live prompt assembly).
//
// Field set is kind-specific:
//   - agent-single / agent-multi: agentName, promptTemplate, retries,
//     timeoutMs, temperature override, model override, variant override
//   - input: inputKey
//   - output: ports list (name + binding)
//   - wrappers: inner node ids (read-only in this drawer — wire-up moves
//     via dragging the inner nodes physically inside the wrapper in P-2-07)
//
// The drawer mutates the workflow definition in place; the parent route
// owns the dirty/save bookkeeping.

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, NumberInput, TextArea, TextInput } from '@/components/Form'
import { computePorts } from './WorkflowCanvas'
import { PromptPreview } from './PromptPreview'

interface Props {
  definition: WorkflowDefinition
  selectedNodeId: string | null
  agents: Agent[]
  onChange: (next: WorkflowDefinition) => void
  onClose: () => void
}

type Tab = 'edit' | 'preview'

export function NodeInspector({ definition, selectedNodeId, agents, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('edit')

  // Reset to edit tab whenever the selection changes.
  useEffect(() => {
    setTab('edit')
  }, [selectedNodeId])

  if (selectedNodeId === null) return null
  const node = definition.nodes.find((n) => n.id === selectedNodeId)
  if (node === undefined) return null

  function patch(next: WorkflowNode) {
    const nodes = definition.nodes.map((n) => (n.id === next.id ? next : n))
    onChange({ ...definition, nodes })
  }

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div className="inspector__kind">{node.kind}</div>
          <div className="inspector__id">
            <code>{node.id}</code>
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
      <div className="tabs inspector__tabs">
        <button
          type="button"
          className={`tabs__tab ${tab === 'edit' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('edit')}
        >
          {t('inspector.tabEdit')}
        </button>
        <button
          type="button"
          className={`tabs__tab ${tab === 'preview' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('preview')}
          disabled={node.kind !== 'agent-single' && node.kind !== 'agent-multi'}
        >
          {t('inspector.tabPreview')}
        </button>
      </div>
      <div className="inspector__body">
        {tab === 'edit' ? (
          <EditForm node={node} agents={agents} definition={definition} onPatch={patch} />
        ) : (
          <PreviewPane node={node} agents={agents} definition={definition} />
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Edit tab
// ---------------------------------------------------------------------------

interface EditProps {
  node: WorkflowNode
  agents: Agent[]
  definition: WorkflowDefinition
  onPatch: (next: WorkflowNode) => void
}

function EditForm({ node, agents, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>

  switch (node.kind) {
    case 'input': {
      const key = typeof rec.inputKey === 'string' ? rec.inputKey : ''
      return (
        <div className="form-grid">
          <Field
            label={t('inspector.fieldInputKey')}
            required
            hint={t('inspector.fieldInputKeyHint')}
          >
            <TextInput
              value={key}
              onChange={(v) =>
                onPatch({
                  ...(node as Record<string, unknown>),
                  inputKey: v,
                } as unknown as WorkflowNode)
              }
            />
          </Field>
        </div>
      )
    }
    case 'output': {
      const ports = Array.isArray(rec.ports)
        ? (rec.ports as Array<{ name: string; bind: { nodeId: string; portName: string } }>)
        : []
      function setPorts(next: typeof ports) {
        onPatch({
          ...(node as Record<string, unknown>),
          ports: next,
        } as unknown as WorkflowNode)
      }
      return (
        <div className="form-grid">
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
    case 'wrapper-git':
    case 'wrapper-loop': {
      const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
      const isLoop = node.kind === 'wrapper-loop'
      if (!isLoop) {
        return (
          <div className="form-grid">
            <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
              <div className="muted">
                {inner.length === 0
                  ? t('inspector.none')
                  : inner.map((i) => <code key={i}>{i} </code>)}
              </div>
            </Field>
          </div>
        )
      }
      const exitCondRaw = (rec.exitCondition as Record<string, unknown> | undefined) ?? {}
      const exitKind = typeof exitCondRaw.kind === 'string' ? exitCondRaw.kind : 'port-empty'
      const exitNodeId = typeof exitCondRaw.nodeId === 'string' ? exitCondRaw.nodeId : ''
      const exitPortName = typeof exitCondRaw.portName === 'string' ? exitCondRaw.portName : ''
      const exitValue = typeof exitCondRaw.value === 'string' ? exitCondRaw.value : ''
      const exitN = typeof exitCondRaw.n === 'number' ? exitCondRaw.n : 1
      const exitSeparator = typeof exitCondRaw.separator === 'string' ? exitCondRaw.separator : ''
      const bindings = Array.isArray(rec.outputBindings)
        ? (rec.outputBindings as Array<{
            name: string
            bind: { nodeId: string; portName: string }
          }>)
        : []
      function update(patch: Record<string, unknown>) {
        onPatch({
          ...(node as Record<string, unknown>),
          ...patch,
        } as unknown as WorkflowNode)
      }
      function updateExit(patch: Record<string, unknown>) {
        update({
          exitCondition: { ...exitCondRaw, ...patch },
        })
      }
      function setBindings(next: typeof bindings) {
        update({ outputBindings: next })
      }
      return (
        <div className="form-grid">
          <div className="info-box info-box--muted">{t('inspector.loopBanner')}</div>
          <Field label={t('inspector.fieldMaxIterations')} required>
            <NumberInput
              value={typeof rec.maxIterations === 'number' ? rec.maxIterations : undefined}
              onChange={(v) => update({ maxIterations: v ?? 1 })}
              min={1}
              step={1}
            />
          </Field>
          <Field
            label={t('inspector.fieldExitConditionKind')}
            hint={t('inspector.fieldExitConditionKindHint')}
          >
            <select
              className="form-input"
              value={exitKind}
              onChange={(e) => updateExit({ kind: e.target.value })}
            >
              <option value="port-empty">port-empty</option>
              <option value="port-equals">port-equals</option>
              <option value="port-count-lt">port-count-lt</option>
            </select>
          </Field>
          <Field
            label={t('inspector.fieldExitConditionTarget')}
            hint={t('inspector.fieldExitConditionTargetHint')}
          >
            <div className="form-grid form-grid--two">
              <TextInput
                value={exitNodeId}
                onChange={(v) => updateExit({ nodeId: v })}
                placeholder={t('inspector.innerNodeIdPlaceholder')}
              />
              <TextInput
                value={exitPortName}
                onChange={(v) => updateExit({ portName: v })}
                placeholder={t('inspector.portPlaceholder')}
              />
            </div>
          </Field>
          {exitKind === 'port-equals' && (
            <Field label={t('inspector.fieldExitConditionValue')}>
              <TextInput value={exitValue} onChange={(v) => updateExit({ value: v })} />
            </Field>
          )}
          {exitKind === 'port-count-lt' && (
            <>
              <Field label={t('inspector.fieldExitConditionN')}>
                <NumberInput
                  value={exitN}
                  onChange={(v) => updateExit({ n: v ?? 1 })}
                  min={1}
                  step={1}
                />
              </Field>
              <Field label={t('inspector.fieldExitConditionSeparator')}>
                <TextInput
                  value={exitSeparator}
                  onChange={(v) => updateExit({ separator: v })}
                  placeholder="\\n"
                />
              </Field>
            </>
          )}
          <Field
            label={t('inspector.fieldOutputBindings')}
            hint={t('inspector.fieldOutputBindingsHint')}
          >
            <ul className="inspector__output-ports">
              {bindings.map((b, i) => (
                <li key={i} className="inspector__output-port-row">
                  <input
                    className="form-input"
                    value={b.name}
                    onChange={(e) => {
                      const copy = [...bindings]
                      copy[i] = { ...b, name: e.target.value }
                      setBindings(copy)
                    }}
                    placeholder={t('inspector.outputNamePlaceholder')}
                  />
                  <input
                    className="form-input form-input--mono"
                    value={b.bind.nodeId}
                    onChange={(e) => {
                      const copy = [...bindings]
                      copy[i] = { ...b, bind: { ...b.bind, nodeId: e.target.value } }
                      setBindings(copy)
                    }}
                    placeholder={t('inspector.innerNodeIdPlaceholder')}
                  />
                  <input
                    className="form-input form-input--mono"
                    value={b.bind.portName}
                    onChange={(e) => {
                      const copy = [...bindings]
                      copy[i] = { ...b, bind: { ...b.bind, portName: e.target.value } }
                      setBindings(copy)
                    }}
                    placeholder={t('inspector.portPlaceholder')}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setBindings(bindings.filter((_, j) => j !== i))}
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
                setBindings([
                  ...bindings,
                  {
                    name: `out_${bindings.length + 1}`,
                    bind: { nodeId: '', portName: '' },
                  },
                ])
              }
            >
              {t('inspector.addBinding')}
            </button>
          </Field>
          <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
            <div className="muted">
              {inner.length === 0
                ? t('inspector.none')
                : inner.map((i) => <code key={i}>{i} </code>)}
            </div>
          </Field>
        </div>
      )
    }
    case 'agent-single':
    case 'agent-multi': {
      const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
      const promptTemplate = typeof rec.promptTemplate === 'string' ? rec.promptTemplate : ''
      const retries = typeof rec.retries === 'number' ? rec.retries : undefined
      const timeoutMs = typeof rec.timeoutMs === 'number' ? rec.timeoutMs : undefined
      const overrides =
        typeof rec.overrides === 'object' && rec.overrides !== null
          ? (rec.overrides as Record<string, unknown>)
          : {}
      const ports = computePorts(node, new Map(agents.map((a) => [a.name, a])), definition)

      function update(p: Record<string, unknown>) {
        onPatch({ ...(node as Record<string, unknown>), ...p } as unknown as WorkflowNode)
      }

      return (
        <div className="form-grid">
          <Field
            label={t('inspector.fieldAgent')}
            required
            hint={node.kind === 'agent-multi' ? t('inspector.fieldAgentHint') : ''}
          >
            <select
              className="form-input"
              value={agentName}
              onChange={(e) => update({ agentName: e.target.value })}
            >
              <option value="">{t('inspector.pickAgent')}</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>

          {node.kind === 'agent-multi' && (
            <Field label={t('inspector.fieldSourcePort')} required>
              <SourcePortField
                value={(rec.sourcePort as { nodeId?: string; portName?: string } | undefined) ?? {}}
                onChange={(sp) => update({ sourcePort: sp })}
              />
            </Field>
          )}

          <Field
            label={t('inspector.fieldPromptTemplate')}
            hint={t('inspector.fieldPromptTemplateHint')}
          >
            <TextArea
              value={promptTemplate}
              onChange={(v) => update({ promptTemplate: v })}
              rows={8}
              monospace
            />
            <PortRefList ports={ports.inputs} />
          </Field>

          <div className="form-grid form-grid--cols-2">
            <Field label={t('inspector.fieldRetries')} hint={t('inspector.fieldRetriesHint')}>
              <NumberInput value={retries} onChange={(v) => update({ retries: v ?? 0 })} min={0} />
            </Field>
            <Field label={t('inspector.fieldTimeoutMs')} hint={t('inspector.fieldTimeoutMsHint')}>
              <NumberInput
                value={timeoutMs}
                onChange={(v) => update({ timeoutMs: v })}
                min={1000}
                step={1000}
              />
            </Field>
            <Field label={t('inspector.fieldModelOverride')}>
              <TextInput
                value={typeof overrides.model === 'string' ? overrides.model : ''}
                onChange={(v) =>
                  update({
                    overrides: { ...overrides, ...(v ? { model: v } : { model: undefined }) },
                  })
                }
                placeholder={t('inspector.modelPlaceholder')}
              />
            </Field>
            <Field label={t('inspector.fieldVariant')}>
              <TextInput
                value={typeof overrides.variant === 'string' ? overrides.variant : ''}
                onChange={(v) =>
                  update({
                    overrides: { ...overrides, ...(v ? { variant: v } : { variant: undefined }) },
                  })
                }
              />
            </Field>
            <Field label={t('inspector.fieldTemperatureOverride')}>
              <NumberInput
                value={
                  typeof overrides.temperature === 'number' ? overrides.temperature : undefined
                }
                onChange={(v) => update({ overrides: { ...overrides, temperature: v } })}
                min={0}
                max={2}
                step={0.1}
              />
            </Field>
          </div>
        </div>
      )
    }
  }
}

function PortRefList({ ports }: { ports: string[] }) {
  const { t } = useTranslation()
  if (ports.length === 0) return null
  return (
    <div className="inspector__port-refs">
      <span className="muted">{t('inspector.resolvedInbound')}</span>{' '}
      <ChipsInput value={ports} onChange={() => {}} placeholder="" />
    </div>
  )
}

function SourcePortField({
  value,
  onChange,
}: {
  value: { nodeId?: string; portName?: string }
  onChange: (next: { nodeId: string; portName: string }) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="form-grid form-grid--cols-2">
      <TextInput
        value={value.nodeId ?? ''}
        onChange={(v) => onChange({ nodeId: v, portName: value.portName ?? '' })}
        placeholder={t('inspector.sourcePortNodePlaceholder')}
      />
      <TextInput
        value={value.portName ?? ''}
        onChange={(v) => onChange({ nodeId: value.nodeId ?? '', portName: v })}
        placeholder={t('inspector.sourcePortPlaceholder')}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview tab
// ---------------------------------------------------------------------------

interface PreviewProps {
  node: WorkflowNode
  agents: Agent[]
  definition: WorkflowDefinition
}

function PreviewPane({ node, agents, definition }: PreviewProps) {
  const { t } = useTranslation()
  if (node.kind !== 'agent-single' && node.kind !== 'agent-multi') {
    return <div className="muted">{t('inspector.previewOnlyAgent')}</div>
  }
  const agentName = (node as Record<string, unknown>).agentName as string | undefined
  const agent = agents.find((a) => a.name === agentName)
  const template = (node as Record<string, unknown>).promptTemplate as string | undefined
  const ports = computePorts(node, new Map(agents.map((a) => [a.name, a])), definition)
  return (
    <PromptPreview
      template={template ?? ''}
      inputPorts={ports.inputs}
      outputs={agent?.outputs ?? []}
    />
  )
}
