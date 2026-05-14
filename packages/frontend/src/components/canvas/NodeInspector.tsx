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
        <button type="button" onClick={onClose} className="inspector__close" aria-label="Close">
          ×
        </button>
      </header>
      <div className="tabs inspector__tabs">
        <button
          type="button"
          className={`tabs__tab ${tab === 'edit' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('edit')}
        >
          Edit
        </button>
        <button
          type="button"
          className={`tabs__tab ${tab === 'preview' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('preview')}
          disabled={node.kind !== 'agent-single' && node.kind !== 'agent-multi'}
        >
          Preview
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
  const rec = node as unknown as Record<string, unknown>

  switch (node.kind) {
    case 'input': {
      const key = typeof rec.inputKey === 'string' ? rec.inputKey : ''
      return (
        <div className="form-grid">
          <Field label="Input key" required hint="Must be unique across the workflow.">
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
          <Field
            label="Output ports"
            hint="Each port = a card on the task detail page; bind to (nodeId, portName)."
          >
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
                    placeholder="port name"
                  />
                  <input
                    className="form-input form-input--mono"
                    value={p.bind.nodeId}
                    onChange={(e) => {
                      const copy = [...ports]
                      copy[i] = { ...p, bind: { ...p.bind, nodeId: e.target.value } }
                      setPorts(copy)
                    }}
                    placeholder="upstream nodeId"
                  />
                  <input
                    className="form-input form-input--mono"
                    value={p.bind.portName}
                    onChange={(e) => {
                      const copy = [...ports]
                      copy[i] = { ...p, bind: { ...p.bind, portName: e.target.value } }
                      setPorts(copy)
                    }}
                    placeholder="port"
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setPorts(ports.filter((_, j) => j !== i))}
                  >
                    Remove
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
              + Add port
            </button>
          </Field>
        </div>
      )
    }
    case 'wrapper-git':
    case 'wrapper-loop': {
      const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
      const isLoop = node.kind === 'wrapper-loop'
      return (
        <div className="form-grid">
          {isLoop && (
            <>
              <Field label="Max iterations" required>
                <NumberInput
                  value={typeof rec.maxIterations === 'number' ? rec.maxIterations : undefined}
                  onChange={(v) =>
                    onPatch({
                      ...(node as Record<string, unknown>),
                      maxIterations: v ?? 1,
                    } as unknown as WorkflowNode)
                  }
                  min={1}
                  step={1}
                />
              </Field>
              <Field
                label="Exit condition kind"
                hint="port-empty / port-equals / port-count-lt (full editor in P-2-09)"
              >
                <TextInput
                  value={
                    typeof rec.exitCondition === 'object' &&
                    rec.exitCondition !== null &&
                    typeof (rec.exitCondition as Record<string, unknown>).kind === 'string'
                      ? ((rec.exitCondition as Record<string, unknown>).kind as string)
                      : 'port-empty'
                  }
                  onChange={(v) =>
                    onPatch({
                      ...(node as Record<string, unknown>),
                      exitCondition: {
                        ...((rec.exitCondition as Record<string, unknown>) ?? {}),
                        kind: v,
                      },
                    } as unknown as WorkflowNode)
                  }
                />
              </Field>
            </>
          )}
          <Field label="Inner node ids" hint="Edit by dragging nodes inside the wrapper (M3).">
            <div className="muted">
              {inner.length === 0 ? 'none' : inner.map((i) => <code key={i}>{i} </code>)}
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
            label="Agent"
            required
            hint={node.kind === 'agent-multi' ? 'Fan-out shards sourcePort across child runs.' : ''}
          >
            <select
              className="form-input"
              value={agentName}
              onChange={(e) => update({ agentName: e.target.value })}
            >
              <option value="">— pick an agent —</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>

          {node.kind === 'agent-multi' && (
            <Field label="sourcePort (nodeId.portName)" required>
              <SourcePortField
                value={(rec.sourcePort as { nodeId?: string; portName?: string } | undefined) ?? {}}
                onChange={(sp) => update({ sourcePort: sp })}
              />
            </Field>
          )}

          <Field
            label="Prompt template"
            hint="Use {{port_name}} + builtins like {{__repo_path__}}."
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
            <Field label="Retries" hint="Default 0">
              <NumberInput value={retries} onChange={(v) => update({ retries: v ?? 0 })} min={0} />
            </Field>
            <Field label="Timeout (ms)" hint="Defaults to settings.defaultPerNodeTimeoutMs">
              <NumberInput
                value={timeoutMs}
                onChange={(v) => update({ timeoutMs: v })}
                min={1000}
                step={1000}
              />
            </Field>
            <Field label="Model override">
              <TextInput
                value={typeof overrides.model === 'string' ? overrides.model : ''}
                onChange={(v) =>
                  update({
                    overrides: { ...overrides, ...(v ? { model: v } : { model: undefined }) },
                  })
                }
                placeholder="anthropic/claude-sonnet-4-6"
              />
            </Field>
            <Field label="Variant">
              <TextInput
                value={typeof overrides.variant === 'string' ? overrides.variant : ''}
                onChange={(v) =>
                  update({
                    overrides: { ...overrides, ...(v ? { variant: v } : { variant: undefined }) },
                  })
                }
              />
            </Field>
            <Field label="Temperature override">
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
  if (ports.length === 0) return null
  return (
    <div className="inspector__port-refs">
      <span className="muted">Resolved inbound ports:</span>{' '}
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
  return (
    <div className="form-grid form-grid--cols-2">
      <TextInput
        value={value.nodeId ?? ''}
        onChange={(v) => onChange({ nodeId: v, portName: value.portName ?? '' })}
        placeholder="upstream node id"
      />
      <TextInput
        value={value.portName ?? ''}
        onChange={(v) => onChange({ nodeId: value.nodeId ?? '', portName: v })}
        placeholder="port name"
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
  if (node.kind !== 'agent-single' && node.kind !== 'agent-multi') {
    return <div className="muted">Preview only available on agent nodes.</div>
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
