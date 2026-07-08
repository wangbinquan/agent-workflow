// Right-side 480px inspector drawer. Opens when the canvas reports a
// selected node; closes when the selection clears. Two tabs: Edit (form)
// and Preview (live prompt assembly).
//
// Field set is kind-specific:
//   - agent-single: agentName, promptTemplate
//     (RFC-113 moved model/variant/temperature to the runtime; RFC-115 moved
//      retries/timeout to global config — the node carries no execution-param
//      overrides anymore. RFC-060 PR-E removed agent-multi; fan-out work goes
//      through wrapper-fanout, which has its own inspector branch below.)
//   - input: inputKey
//   - output: ports list (name + binding)
//   - wrappers: inner node ids (read-only in this drawer — wire-up moves
//     via dragging the inner nodes physically inside the wrapper in P-2-07)
//
// The drawer mutates the workflow definition in place; the parent route
// owns the dirty/save bookkeeping.

import type { Agent, WorkflowDefinition, WorkflowInput, WorkflowNode } from '@agent-workflow/shared'
import {
  CLARIFY_SOURCE_PORT_NAME,
  deriveWrapperFanoutOutputs,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveClarifySessionMode,
  tryParseKind,
} from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { KindSelect } from '@/components/KindSelect'
import { Select } from '@/components/Select'
import { computePorts } from './WorkflowCanvas'
import { REVIEW_INPUT_HANDLE_ID, syncEdgeFromFormField } from './connectionSync'
import { patchInputDef, renameInputKey } from './syncInputDefs'
import { PromptPreview } from './PromptPreview'
import { loopMemberCandidates } from './wrapperCandidates'

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

  // PreviewPane only renders prompt-template assembly for agent kinds; other
  // kinds previously got a disabled tab + "preview only available for agents"
  // muted message. Hiding the tab entirely (per user feedback) drops the
  // dead surface and avoids the implicit "this is greyed out for a reason"
  // confusion. Force the active tab back to edit when previewing isn't
  // available so a stale `tab === 'preview'` from a prior agent selection
  // doesn't render an empty pane.
  const hasPreview = node.kind === 'agent-single'
  const activeTab: Tab = !hasPreview ? 'edit' : tab

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
      <div className="tabs tabs--inspector">
        <button
          type="button"
          className={`tabs__tab ${activeTab === 'edit' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('edit')}
        >
          {t('inspector.tabEdit')}
        </button>
        {hasPreview && (
          <button
            type="button"
            className={`tabs__tab ${activeTab === 'preview' ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab('preview')}
          >
            {t('inspector.tabPreview')}
          </button>
        )}
      </div>
      <div className="inspector__body">
        {activeTab === 'edit' ? (
          <EditForm
            node={node}
            agents={agents}
            definition={definition}
            onPatch={patch}
            onCommitDef={onChange}
          />
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
  /**
   * Apply a multi-field workflow definition change. Used by branches that
   * need to mutate the node + other parts of the definition atomically
   * (e.g. RFC-004 input-node inputKey rename touches inputs[] + edges, and
   * the inputs[] entry edits live outside the node itself).
   */
  onCommitDef: (next: WorkflowDefinition) => void
}

function EditForm({ node, agents, definition, onPatch, onCommitDef }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const nodeTitle = typeof rec.title === 'string' ? rec.title : ''
  // Shared display-name input rendered above every kind-specific form.
  // Writes go through onPatch so review/clarify (which already used the same
  // `title` field) continue to roundtrip identically; agent-* / input /
  // output / wrappers opt in via the same key.
  const titleField = (
    <Field label={t('inspector.fieldNodeTitle')} hint={t('inspector.fieldNodeTitleHint')}>
      <TextInput
        value={nodeTitle}
        onChange={(v) => {
          // Strip the field entirely when the user blanks it so the canvas
          // falls back to the kind-specific derivation (agentName etc.).
          const next = { ...(node as Record<string, unknown>) }
          if (v.length === 0) delete next.title
          else next.title = v
          onPatch(next as unknown as WorkflowNode)
        }}
      />
    </Field>
  )

  switch (node.kind) {
    case 'input': {
      const key = typeof rec.inputKey === 'string' ? rec.inputKey : ''
      // RFC-004: inputKey is the single source of truth for the launcher form
      // entry. Edits to the launcher field's kind / label / required /
      // description land on definition.inputs[].
      const inputDef: WorkflowInput | undefined = (definition.inputs ?? []).find(
        (i) => i.key === key,
      )
      const inputKind = (inputDef?.kind ?? 'text') as WorkflowInput['kind']
      const inputLabel = inputDef?.label ?? key
      const inputRequired = inputDef?.required ?? true
      const inputDescription = inputDef?.description ?? ''
      return (
        <div className="form-grid">
          {titleField}
          <Field
            label={t('inspector.fieldInputKey')}
            required
            hint={t('inspector.fieldInputKeyHint')}
          >
            <TextInput
              value={key}
              onChange={(v) => {
                if (v.length === 0 || v === key) return
                onCommitDef(renameInputKey(definition, node.id, v))
              }}
            />
          </Field>
          <Field label={t('inspector.fieldInputKind')} hint={t('inspector.fieldInputKindHint')}>
            <Select<WorkflowInput['kind']>
              value={inputKind}
              ariaLabel={t('inspector.fieldInputKind')}
              onChange={(v) => onCommitDef(patchInputDef(definition, key, { kind: v }))}
              options={[
                { value: 'text', label: 'text' },
                { value: 'files', label: 'files' },
                { value: 'enum', label: 'enum' },
                { value: 'git', label: 'git' },
                { value: 'upload', label: 'upload' },
              ]}
            />
          </Field>
          {inputKind === 'upload' && (
            <UploadInputFields
              def={inputDef ?? { kind: 'upload', key, label: inputLabel }}
              onPatch={(patch) => onCommitDef(patchInputDef(definition, key, patch))}
            />
          )}
          <Field label={t('inspector.fieldInputLabel')} hint={t('inspector.fieldInputLabelHint')}>
            <TextInput
              value={inputLabel}
              onChange={(v) => onCommitDef(patchInputDef(definition, key, { label: v }))}
            />
          </Field>
          <Field label={t('inspector.fieldInputRequired')}>
            <Switch
              checked={inputRequired}
              onChange={(c) => onCommitDef(patchInputDef(definition, key, { required: c }))}
              label={t('inspector.fieldInputRequired')}
            />
          </Field>
          <Field
            label={t('inspector.fieldInputDescription')}
            hint={t('inspector.fieldInputDescriptionHint')}
          >
            <TextArea
              value={inputDescription}
              rows={3}
              onChange={(v) => onCommitDef(patchInputDef(definition, key, { description: v }))}
            />
          </Field>
        </div>
      )
    }
    case 'output': {
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
          {titleField}
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
            {titleField}
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
          {titleField}
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
            <Select<string>
              value={exitKind}
              ariaLabel={t('inspector.fieldExitConditionKind')}
              onChange={(v) => updateExit({ kind: v })}
              options={[
                { value: 'port-empty', label: 'port-empty' },
                { value: 'port-not-empty', label: 'port-not-empty' },
                { value: 'port-equals', label: 'port-equals' },
                { value: 'port-count-lt', label: 'port-count-lt' },
              ]}
            />
          </Field>
          <Field
            label={t('inspector.fieldExitConditionTarget')}
            hint={t('inspector.fieldExitConditionTargetHint')}
          >
            {(() => {
              // RFC-016 T7: candidate-driven selects replace the bare
              // TextInputs. Candidates are computed from the wrapper's
              // current nodeIds + each member's declared output ports so a
              // node moved out of the loop can no longer be referenced.
              const candidates = loopMemberCandidates(node, definition, agents)
              const currentCand = candidates.find((c) => c.nodeId === exitNodeId)
              const nodeIdInvalid = exitNodeId.length > 0 && currentCand === undefined
              const portCandidates = currentCand?.outputPorts ?? []
              const portInvalid = exitPortName.length > 0 && !portCandidates.includes(exitPortName)
              return (
                <div className="form-grid form-grid--two">
                  <div>
                    <Select<string>
                      className={nodeIdInvalid ? 'form-input--invalid' : undefined}
                      value={exitNodeId}
                      ariaLabel={t('inspector.loopExitNodeIdSelect')}
                      onChange={(v) => updateExit({ nodeId: v })}
                      data-testid="loop-exit-node-select"
                      options={[
                        { value: '', label: t('inspector.loopExitNodeIdSelect') },
                        ...candidates.map((c) => ({
                          value: c.nodeId,
                          label: c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId,
                        })),
                        ...(nodeIdInvalid
                          ? [
                              {
                                value: exitNodeId,
                                label: t('inspector.missingOption', { value: exitNodeId }),
                              },
                            ]
                          : []),
                      ]}
                    />
                    {nodeIdInvalid ? (
                      <div className="form-input__error">
                        {t('inspector.loopExitInvalidNodeId', { nodeId: exitNodeId })}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <Select<string>
                      className={portInvalid ? 'form-input--invalid' : undefined}
                      value={exitPortName}
                      ariaLabel={t('inspector.loopExitPortNameSelect')}
                      onChange={(v) => updateExit({ portName: v })}
                      disabled={exitNodeId.length === 0}
                      data-testid="loop-exit-port-select"
                      options={[
                        { value: '', label: t('inspector.loopExitPortNameSelect') },
                        ...portCandidates.map((p) => ({ value: p, label: p })),
                        ...(portInvalid
                          ? [
                              {
                                value: exitPortName,
                                label: t('inspector.missingOption', { value: exitPortName }),
                              },
                            ]
                          : []),
                      ]}
                    />
                    {portInvalid ? (
                      <div className="form-input__error">
                        {t('inspector.loopExitInvalidPortName', { portName: exitPortName })}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })()}
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
              {bindings.map((b, i) => {
                // RFC-016 T7: same candidate-driven select pattern used in
                // exitCondition target — each binding row references an
                // inner member node + its declared output port.
                const candidates = loopMemberCandidates(node, definition, agents)
                const currentCand = candidates.find((c) => c.nodeId === b.bind.nodeId)
                const bindNodeInvalid = b.bind.nodeId.length > 0 && currentCand === undefined
                const bindPortCandidates = currentCand?.outputPorts ?? []
                const bindPortInvalid =
                  b.bind.portName.length > 0 && !bindPortCandidates.includes(b.bind.portName)
                return (
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
                    <Select<string>
                      className={`form-input--mono${bindNodeInvalid ? ' form-input--invalid' : ''}`}
                      value={b.bind.nodeId}
                      ariaLabel={t('inspector.loopExitNodeIdSelect')}
                      onChange={(v) => {
                        const copy = [...bindings]
                        copy[i] = { ...b, bind: { ...b.bind, nodeId: v } }
                        setBindings(copy)
                      }}
                      options={[
                        { value: '', label: t('inspector.loopExitNodeIdSelect') },
                        ...candidates.map((c) => ({
                          value: c.nodeId,
                          label: c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId,
                        })),
                        ...(bindNodeInvalid
                          ? [
                              {
                                value: b.bind.nodeId,
                                label: t('inspector.missingOption', { value: b.bind.nodeId }),
                              },
                            ]
                          : []),
                      ]}
                    />
                    <Select<string>
                      className={`form-input--mono${bindPortInvalid ? ' form-input--invalid' : ''}`}
                      value={b.bind.portName}
                      ariaLabel={t('inspector.loopExitPortNameSelect')}
                      onChange={(v) => {
                        const copy = [...bindings]
                        copy[i] = { ...b, bind: { ...b.bind, portName: v } }
                        setBindings(copy)
                      }}
                      disabled={b.bind.nodeId.length === 0}
                      options={[
                        { value: '', label: t('inspector.loopExitPortNameSelect') },
                        ...bindPortCandidates.map((p) => ({ value: p, label: p })),
                        ...(bindPortInvalid
                          ? [
                              {
                                value: b.bind.portName,
                                label: t('inspector.missingOption', { value: b.bind.portName }),
                              },
                            ]
                          : []),
                      ]}
                    />
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setBindings(bindings.filter((_, j) => j !== i))}
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
    case 'wrapper-fanout': {
      // RFC-060 — wrapper-fanout inspector. Authors edit inputs[] (name +
      // kind + isShardSource flag); inner nodeIds[] read-only (managed
      // via canvas drag), outputs[] derived from inner aggregator agent
      // (or implicit __done__ signal).
      const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
      type FanoutInput = { name: string; kind: string; isShardSource?: boolean }
      const inputsList: FanoutInput[] = Array.isArray(rec.inputs)
        ? (rec.inputs as unknown[]).filter(
            (i): i is FanoutInput =>
              typeof i === 'object' &&
              i !== null &&
              typeof (i as Record<string, unknown>).name === 'string' &&
              typeof (i as Record<string, unknown>).kind === 'string',
          )
        : []
      const derivedOutputs = deriveWrapperFanoutOutputs(
        definition,
        node.id,
        new Map(agents.map((a) => [a.name, a])),
      )
      function update(patch: Record<string, unknown>) {
        onPatch({
          ...(node as Record<string, unknown>),
          ...patch,
        } as unknown as WorkflowNode)
      }
      function setInputs(next: FanoutInput[]) {
        update({ inputs: next })
      }
      function patchInput(idx: number, patch: Partial<FanoutInput>) {
        const next = inputsList.map((p, i) => (i === idx ? { ...p, ...patch } : p))
        setInputs(next)
      }
      function removeInput(idx: number) {
        const next = inputsList.filter((_, i) => i !== idx)
        setInputs(next)
      }
      function addInput() {
        const next = [
          ...inputsList,
          { name: `input_${inputsList.length + 1}`, kind: 'list<string>' },
        ]
        // If no shardSource present, mark the first as shardSource so the
        // validator's wrapper-fanout-shard-source-missing rule doesn't
        // immediately flag the new wrapper.
        if (!inputsList.some((p) => p.isShardSource === true)) {
          next[next.length - 1] = { ...next[next.length - 1]!, isShardSource: true }
        }
        setInputs(next)
      }
      return (
        <div className="form-grid">
          {titleField}
          <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
            <div className="muted">
              {inner.length === 0
                ? t('inspector.none')
                : inner.map((i) => <code key={i}>{i} </code>)}
            </div>
          </Field>
          <Field label={t('inspector.fanoutInputs')} hint={t('inspector.fanoutInputsHint')}>
            <div className="fanout-inputs-list">
              {inputsList.map((p, idx) => {
                const parsed = tryParseKind(p.kind)
                const isShardKindOk = parsed?.kind === 'list'
                // Find inbound edges wired to this port. The user asked us
                // NOT to split "inbound edges" into its own panel — surface
                // each edge inline on the corresponding input row so the
                // inputs[] list is the single source of truth.
                const wiredFrom = definition.edges.filter(
                  (e) => e.target.nodeId === node.id && e.target.portName === p.name,
                )
                return (
                  <div key={idx} className="fanout-input-row-wrap">
                    <div className="fanout-input-row">
                      <TextInput
                        value={p.name}
                        onChange={(v) => patchInput(idx, { name: v })}
                        placeholder={t('inspector.fanoutInputNamePlaceholder')}
                      />
                      <KindSelect
                        value={p.kind}
                        onChange={(v) => patchInput(idx, { kind: v })}
                        testidPrefix={`fanout-input-kind-${idx}`}
                      />
                      <Switch
                        checked={p.isShardSource === true}
                        onChange={(v) => {
                          // Mark this one as shardSource and clear others (singleton invariant).
                          const next = inputsList.map((q, i) => ({
                            ...q,
                            isShardSource: i === idx ? v : false,
                          }))
                          setInputs(next)
                        }}
                        label={t('inspector.fanoutInputShardSource')}
                      />
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => removeInput(idx)}
                        aria-label={t('inspector.fanoutInputRemove')}
                      >
                        ×
                      </button>
                    </div>
                    {p.isShardSource === true && !isShardKindOk ? (
                      <div className="muted muted--warn">
                        {t('inspector.fanoutInputShardSourceMustBeList')}
                      </div>
                    ) : null}
                    <div className="fanout-input-wired">
                      {wiredFrom.length === 0 ? (
                        <span className="muted">{t('inspector.fanoutInputUnwired')}</span>
                      ) : (
                        wiredFrom.map((e) => (
                          <span key={e.id} className="fanout-input-wired__src">
                            ← <code>{e.source.nodeId}</code>
                            <span>.</span>
                            <code>{e.source.portName}</code>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                )
              })}
              <button type="button" className="btn btn--sm" onClick={addInput}>
                {t('inspector.fanoutInputAdd')}
              </button>
            </div>
          </Field>
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
    case 'review': {
      // RFC-005: human review node config. inputSource is the (upstream, port)
      // we'll snapshot into doc_versions; rerunnable lists are subsets of
      // reachable upstream node ids (validator enforces). Comma-separated
      // text input keeps the inspector light — we could swap to a multi-select
      // chip picker in a polish pass.
      const inputSource = (rec.inputSource ?? {}) as Record<string, unknown> as {
        nodeId?: string
        portName?: string
      }
      const description = typeof rec.description === 'string' ? rec.description : ''
      const rerunnableOnReject = Array.isArray(rec.rerunnableOnReject)
        ? (rec.rerunnableOnReject as string[])
        : []
      const rerunnableOnIterate = Array.isArray(rec.rerunnableOnIterate)
        ? (rec.rerunnableOnIterate as string[])
        : []
      const rollbackFilesOnReject =
        typeof rec.rollbackFilesOnReject === 'boolean' ? rec.rollbackFilesOnReject : true
      const rollbackFilesOnIterate =
        typeof rec.rollbackFilesOnIterate === 'boolean' ? rec.rollbackFilesOnIterate : false
      const commentInjectTemplate =
        typeof rec.commentInjectTemplate === 'string' ? rec.commentInjectTemplate : ''

      // Candidate upstream node ids = every node in the workflow except this
      // one and any output sink. Validator enforces "subset of reachable
      // upstreams" — this dropdown is the friendly version.
      const upstreamCandidates = definition.nodes
        .filter((n) => n.id !== node.id && n.kind !== 'output')
        .map((n) => n.id)

      const patchReview = (delta: Record<string, unknown>): void =>
        onPatch({
          ...(node as Record<string, unknown>),
          ...delta,
        } as unknown as WorkflowNode)

      /**
       * RFC-007: changing inputSource via the form must keep the canvas
       * edge in lock-step. We rebuild the node + recompute edges in one
       * commit so the auto-save sees a consistent definition.
       */
      const patchReviewInputSource = (nextSource: { nodeId: string; portName: string }): void => {
        const prevSource = {
          nodeId: inputSource.nodeId ?? '',
          portName: inputSource.portName ?? '',
        }
        const nodes = definition.nodes.map((n) =>
          n.id === node.id
            ? ({
                ...(n as Record<string, unknown>),
                inputSource: nextSource,
              } as unknown as WorkflowNode)
            : n,
        )
        const nextDef = syncEdgeFromFormField(
          { ...definition, nodes },
          { nodeId: node.id, portName: REVIEW_INPUT_HANDLE_ID },
          prevSource,
          nextSource,
        )
        onCommitDef(nextDef)
      }

      return (
        <div className="form-grid">
          {titleField}
          <Field
            label={t('inspector.fieldReviewDescription')}
            hint={t('inspector.fieldReviewDescriptionHint')}
          >
            <TextArea
              value={description}
              rows={2}
              onChange={(v) => patchReview({ description: v })}
            />
          </Field>
          <Field
            label={t('inspector.fieldReviewInputSourceNode')}
            hint={t('inspector.fieldReviewInputSourceNodeHint')}
            required
          >
            <Select<string>
              value={inputSource.nodeId ?? ''}
              ariaLabel={t('inspector.fieldReviewInputSourceNode')}
              onChange={(v) =>
                patchReviewInputSource({
                  nodeId: v,
                  portName: inputSource.portName ?? '',
                })
              }
              options={[
                { value: '', label: '—' },
                ...upstreamCandidates.map((id) => ({ value: id, label: id })),
              ]}
            />
          </Field>
          <Field
            label={t('inspector.fieldReviewInputSourcePort')}
            hint={t('inspector.fieldReviewInputSourcePortHint')}
            required
          >
            <TextInput
              value={inputSource.portName ?? ''}
              onChange={(v) =>
                patchReviewInputSource({ nodeId: inputSource.nodeId ?? '', portName: v })
              }
              placeholder="design"
            />
          </Field>
          <Field
            label={t('inspector.fieldReviewRerunReject')}
            hint={t('inspector.fieldReviewRerunRejectHint')}
          >
            <TextInput
              value={rerunnableOnReject.join(', ')}
              onChange={(v) =>
                patchReview({
                  rerunnableOnReject: v
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              placeholder={inputSource.nodeId ?? ''}
            />
          </Field>
          <Field
            label={t('inspector.fieldReviewRerunIterate')}
            hint={t('inspector.fieldReviewRerunIterateHint')}
          >
            <TextInput
              value={rerunnableOnIterate.join(', ')}
              onChange={(v) =>
                patchReview({
                  rerunnableOnIterate: v
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              placeholder={inputSource.nodeId ?? ''}
            />
          </Field>
          <Field label={t('inspector.fieldReviewRollbackReject')}>
            <Switch
              checked={rollbackFilesOnReject}
              onChange={(c) => patchReview({ rollbackFilesOnReject: c })}
              label={t('inspector.fieldReviewRollbackRejectLabel')}
            />
          </Field>
          <Field label={t('inspector.fieldReviewRollbackIterate')}>
            <Switch
              checked={rollbackFilesOnIterate}
              onChange={(c) => patchReview({ rollbackFilesOnIterate: c })}
              label={t('inspector.fieldReviewRollbackIterateLabel')}
            />
          </Field>
          <Field
            label={t('inspector.fieldReviewCommentTemplate')}
            hint={t('inspector.fieldReviewCommentTemplateHint')}
          >
            <TextArea
              value={commentInjectTemplate}
              rows={3}
              onChange={(v) => patchReview({ commentInjectTemplate: v })}
              placeholder=""
            />
          </Field>
        </div>
      )
    }
    case 'clarify': {
      // RFC-023 — only `title` and `description` are user-editable; the
      // asking agent is linked via reverse-drag in the canvas (the system
      // ports `__clarify__` / `__clarify_response__` carry that link).
      // Ports are hard-coded ('questions' / 'answers') so we do NOT expose
      // a port editor.
      const description = typeof rec.description === 'string' ? rec.description : ''

      // Find the linked agent (if any) by walking edges for a `__clarify__`
      // source whose target is this clarify node. There can be at most one
      // by validator rule `clarify-multiple-clarify-on-same-agent`.
      const linkedAgentEdge = definition.edges.find(
        (e) => e.source.portName === CLARIFY_SOURCE_PORT_NAME && e.target.nodeId === node.id,
      )
      const linkedAgentId = linkedAgentEdge?.source.nodeId ?? null

      // Detect whether this clarify node sits inside any wrapper-loop's body
      // (so the validator's `clarify-no-iteration-cap` warning lines up).
      const enclosingLoop = definition.nodes.find((n) => {
        if (n.kind !== 'wrapper-loop') return false
        const ids = (n as Record<string, unknown>).nodeIds
        return Array.isArray(ids) && ids.includes(node.id)
      })
      const inLoop = enclosingLoop !== undefined

      function patchClarify(delta: Record<string, unknown>): void {
        onPatch({ ...(node as Record<string, unknown>), ...delta } as unknown as WorkflowNode)
      }

      return (
        <div className="form-grid">
          {titleField}
          <Field
            label={t('inspector.fieldClarifyDescription')}
            hint={t('inspector.fieldClarifyDescriptionHint')}
          >
            <TextArea
              value={description}
              rows={2}
              onChange={(v) => patchClarify({ description: v })}
            />
          </Field>
          <Field label={t('inspector.fieldClarifyLinkedAgent')}>
            {linkedAgentId !== null ? (
              <div className="inspector__readonly">
                <code data-testid="clarify-linked-agent">{linkedAgentId}</code>
              </div>
            ) : (
              <div
                className="inspector__readonly inspector__readonly--error"
                data-testid="clarify-linked-agent-missing"
              >
                {t('inspector.clarifyLinkedAgentMissing')}
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {t('inspector.clarifyLinkedAgentHint')}
            </p>
          </Field>
          <Field label={t('inspector.fieldClarifyInLoop')}>
            {inLoop ? (
              <div className="inspector__readonly" data-testid="clarify-in-loop">
                {t('inspector.clarifyInLoopYes')}
              </div>
            ) : (
              <div
                className="inspector__readonly inspector__readonly--warning"
                data-testid="clarify-in-loop-warning"
              >
                {t('inspector.clarifyInLoopNo')}
              </div>
            )}
          </Field>
          {/* RFC-026: clarify session mode (isolated vs inline). Missing
              field is normalised to 'isolated' (RFC-023 byte-for-byte). */}
          <Field
            label={t('inspector.fieldClarifySessionMode')}
            hint={t('inspector.clarifySessionModeHint')}
            group
          >
            <div
              className="segmented"
              role="radiogroup"
              aria-label={t('inspector.fieldClarifySessionMode')}
              data-testid="clarify-session-mode"
            >
              {(['isolated', 'inline'] as const).map((mode) => {
                // flag-audit W0：缺省归一走 shared 单源（其 docstring 明言就是为了
                // 阻止 `?? 'isolated'` 在各消费点 sprinkle）。
                const active =
                  resolveClarifySessionMode(
                    node as Parameters<typeof resolveClarifySessionMode>[0],
                  ) === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={'segmented__option' + (active ? ' segmented__option--active' : '')}
                    data-testid={`clarify-session-mode-${mode}`}
                    onClick={() => {
                      // Explicit field write keeps roundtripping deterministic:
                      // even 'isolated' is stored when the user clicks it, so
                      // the workflow.definition surfaces the user's choice.
                      patchClarify({ sessionMode: mode })
                    }}
                  >
                    {mode === 'isolated'
                      ? t('inspector.clarifySessionModeIsolated')
                      : t('inspector.clarifySessionModeInline')}
                  </button>
                )
              })}
            </div>
          </Field>
        </div>
      )
    }
    case 'clarify-cross-agent': {
      // RFC-056 cross-clarify node inspector — title + description (same as
      // RFC-023) plus a segmented `sessionModeForQuestioner` selector. Mirrors
      // the RFC-023 same-node clarify inspector's read-only status fields so the
      // two detail panels stay visually aligned: linked questioner / linked
      // designer / wrapper-loop containment. (The designer-rerun session toggle
      // was removed by RFC-056 patch 2026-06-22 — it was dead config; the
      // designer rerun is always isolated.)
      const description = typeof rec.description === 'string' ? rec.description : ''
      const sessionModeForQuestioner =
        typeof rec.sessionModeForQuestioner === 'string' &&
        (rec.sessionModeForQuestioner === 'inline' || rec.sessionModeForQuestioner === 'isolated')
          ? (rec.sessionModeForQuestioner as 'inline' | 'isolated')
          : 'isolated'

      // Linked questioner (auto-edge from questioner.__clarify__ →
      // cross.questions) and linked designer (manual edge from cross.to_designer
      // → designer.__external_feedback__) — same data-source the validator and
      // runtime use.
      const linkedQuestionerId = findQuestionerNodeForCrossClarify(definition, node.id) ?? null
      const linkedDesignerId = findDesignerNodeForCrossClarify(definition, node.id) ?? null

      // wrapper-loop containment, identical to the same-node clarify branch.
      const enclosingLoop = definition.nodes.find((n) => {
        if (n.kind !== 'wrapper-loop') return false
        const ids = (n as Record<string, unknown>).nodeIds
        return Array.isArray(ids) && ids.includes(node.id)
      })
      const inLoop = enclosingLoop !== undefined

      function patchCrossClarify(delta: Record<string, unknown>): void {
        onPatch({ ...(node as Record<string, unknown>), ...delta } as unknown as WorkflowNode)
      }

      return (
        <div className="form-grid" data-testid="cross-clarify-inspector">
          {titleField}
          <Field
            label={t('inspector.fieldClarifyDescription')}
            hint={t('inspector.fieldClarifyDescriptionHint')}
          >
            <TextArea
              value={description}
              rows={2}
              onChange={(v) => patchCrossClarify({ description: v })}
            />
          </Field>
          <Field label={t('crossClarify.inspector.fieldLinkedQuestioner')}>
            {linkedQuestionerId !== null ? (
              <div className="inspector__readonly">
                <code data-testid="cross-clarify-linked-questioner">{linkedQuestionerId}</code>
              </div>
            ) : (
              <div
                className="inspector__readonly inspector__readonly--error"
                data-testid="cross-clarify-linked-questioner-missing"
              >
                {t('crossClarify.inspector.linkedQuestionerMissing')}
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {t('crossClarify.inspector.linkedQuestionerHint')}
            </p>
          </Field>
          <Field label={t('crossClarify.inspector.fieldLinkedDesigner')}>
            {linkedDesignerId !== null ? (
              <div className="inspector__readonly">
                <code data-testid="cross-clarify-linked-designer">{linkedDesignerId}</code>
              </div>
            ) : (
              <div
                className="inspector__readonly inspector__readonly--error"
                data-testid="cross-clarify-linked-designer-missing"
              >
                {t('crossClarify.inspector.linkedDesignerMissing')}
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {t('crossClarify.inspector.linkedDesignerHint')}
            </p>
          </Field>
          <Field label={t('crossClarify.inspector.fieldInLoop')}>
            {inLoop ? (
              <div className="inspector__readonly" data-testid="cross-clarify-in-loop">
                {t('crossClarify.inspector.inLoopYes')}
              </div>
            ) : (
              <div
                className="inspector__readonly inspector__readonly--warning"
                data-testid="cross-clarify-in-loop-warning"
              >
                {t('crossClarify.inspector.inLoopNo')}
              </div>
            )}
          </Field>
          <Field
            label={t('crossClarify.inspector.sessionModeForQuestioner')}
            hint={t('crossClarify.inspector.sessionModeHint')}
            group
          >
            <div
              className="segmented"
              role="radiogroup"
              aria-label={t('crossClarify.inspector.sessionModeForQuestioner')}
              data-testid="cross-clarify-session-mode-questioner"
            >
              {(['isolated', 'inline'] as const).map((mode) => {
                const active = sessionModeForQuestioner === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={'segmented__option' + (active ? ' segmented__option--active' : '')}
                    data-testid={`cross-clarify-session-mode-questioner-${mode}`}
                    onClick={() => patchCrossClarify({ sessionModeForQuestioner: mode })}
                  >
                    {mode === 'isolated'
                      ? t('crossClarify.inspector.sessionModeIsolated')
                      : t('crossClarify.inspector.sessionModeInline')}
                  </button>
                )
              })}
            </div>
          </Field>
        </div>
      )
    }
    case 'agent-single': {
      const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
      const promptTemplate = typeof rec.promptTemplate === 'string' ? rec.promptTemplate : ''
      const ports = computePorts(node, new Map(agents.map((a) => [a.name, a])), definition)

      function update(p: Record<string, unknown>) {
        onPatch({ ...(node as Record<string, unknown>), ...p } as unknown as WorkflowNode)
      }

      return (
        <div className="form-grid">
          {titleField}
          {/* RFC-060 PR-E: agent-multi removed — its sourcePort + sharding
              strategy inspector sections are deleted; agent-single is now the
              only agent node kind. Fan-out work goes through wrapper-fanout. */}
          <Field label={t('inspector.fieldAgent')} required>
            <Select<string>
              value={agentName}
              placeholder={t('inspector.pickAgent')}
              ariaLabel={t('inspector.fieldAgent')}
              onChange={(v) => update({ agentName: v })}
              options={[
                { value: '', label: t('inspector.pickAgent') },
                ...agents.map((a) => ({ value: a.name, label: a.name })),
              ]}
            />
          </Field>

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
            <MissingRefList template={promptTemplate} inputPorts={ports.inputs} />
          </Field>
          {/* RFC-115: per-node retries + timeout overrides removed — both are
              now global execution policy (config.defaultNodeRetries /
              defaultPerNodeTimeoutMs), set in Settings → Limits. */}
        </div>
      )
    }
  }
}

/**
 * Lists `{{xxx}}` placeholders in the prompt template that don't have a
 * matching input port (i.e., no inbound edge with that target.portName).
 * Mirror of the P-2-01 backend validator's "template ref missing" rule,
 * surfaced at edit time so users can self-debug before launching.
 *
 * Built-in meta tokens (e.g., `__repo_path__`) are always available at
 * runtime, so we exclude any name starting with `__`.
 *
 * Exported for unit tests.
 */
export function extractMissingRefs(template: string, inputPorts: string[]): string[] {
  const re = /\{\{(\w+)\}\}/g
  const refs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const name = m[1]
    if (name === undefined || name.startsWith('__')) continue
    refs.add(name)
  }
  const have = new Set(inputPorts)
  return [...refs].filter((r) => !have.has(r))
}

function MissingRefList({ template, inputPorts }: { template: string; inputPorts: string[] }) {
  const { t } = useTranslation()
  const missing = extractMissingRefs(template, inputPorts)
  if (missing.length === 0) return null
  return (
    <div className="inspector__port-refs inspector__port-refs--missing">
      <span className="muted">{t('inspector.missingRefsLabel')}</span>{' '}
      <ChipsInput value={missing} onChange={() => {}} placeholder="" />
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {t('inspector.missingRefsHint')}
      </p>
    </div>
  )
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

// RFC-060 PR-E: sourcePortOptions + SourcePortField (the RFC-015
// agent-multi sourcePort dropdowns) were removed alongside the agent-multi
// NodeKind. wrapper-fanout uses real boundary-input edges on the canvas
// instead, so no equivalent inspector field is needed.

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
  if (node.kind !== 'agent-single') {
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
      outputKinds={agent?.outputKinds}
    />
  )
}

/**
 * RFC-020: per-input editor for `kind: 'upload'` launcher fields. Mirrors
 * UploadInputSchema in @agent-workflow/shared so anything the editor saves
 * round-trips through the strict-on-write validator.
 */
function UploadInputFields({
  def,
  onPatch,
}: {
  def: WorkflowInput
  onPatch: (patch: Partial<WorkflowInput>) => void
}) {
  const { t } = useTranslation()
  const rec = def as Record<string, unknown>
  const targetDir = typeof rec.targetDir === 'string' ? rec.targetDir : ''
  const acceptArr = Array.isArray(rec.accept) ? (rec.accept as string[]) : []
  const acceptText = acceptArr.join(', ')
  const maxFileSize = typeof rec.maxFileSize === 'number' ? rec.maxFileSize : undefined
  const minCount = typeof rec.minCount === 'number' ? rec.minCount : undefined
  const maxCount = typeof rec.maxCount === 'number' ? rec.maxCount : undefined
  const targetDirInvalid =
    targetDir === '' ||
    targetDir.includes('..') ||
    targetDir.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(targetDir)
  return (
    <>
      <Field
        label={t('inspector.upload.targetDir')}
        hint={
          targetDirInvalid
            ? t('inspector.upload.targetDirError')
            : t('inspector.upload.targetDirHint')
        }
        required
      >
        <TextInput
          value={targetDir}
          onChange={(v) => onPatch({ ...(def as object), targetDir: v } as Partial<WorkflowInput>)}
          placeholder="inputs/refs"
        />
      </Field>
      <Field label={t('inspector.upload.accept')} hint={t('inspector.upload.acceptHint')}>
        <TextInput
          value={acceptText}
          onChange={(v) => {
            const next = v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
            onPatch({ ...(def as object), accept: next } as Partial<WorkflowInput>)
          }}
          placeholder=".pdf, image/*"
        />
      </Field>
      <Field label={t('inspector.upload.maxFileSize')} hint={t('inspector.upload.maxFileSizeHint')}>
        <input
          className="form-input"
          type="number"
          min={1}
          value={maxFileSize ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({
              ...(def as object),
              maxFileSize: n,
            } as Partial<WorkflowInput>)
          }}
          placeholder="52428800"
        />
      </Field>
      <Field label={t('inspector.upload.minCount')}>
        <input
          className="form-input"
          type="number"
          min={0}
          value={minCount ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({ ...(def as object), minCount: n } as Partial<WorkflowInput>)
          }}
        />
      </Field>
      <Field label={t('inspector.upload.maxCount')}>
        <input
          className="form-input"
          type="number"
          min={1}
          value={maxCount ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({ ...(def as object), maxCount: n } as Partial<WorkflowInput>)
          }}
        />
      </Field>
    </>
  )
}
