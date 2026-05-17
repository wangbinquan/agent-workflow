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

import type { Agent, WorkflowDefinition, WorkflowInput, WorkflowNode } from '@agent-workflow/shared'
import { CLARIFY_SOURCE_PORT_NAME } from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { ModelSelect } from '@/components/ModelSelect'
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
  const hasPreview = node.kind === 'agent-single' || node.kind === 'agent-multi'
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
      <div className="tabs inspector__tabs">
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
            <select
              className="form-input"
              value={inputKind}
              onChange={(e) =>
                onCommitDef(
                  patchInputDef(definition, key, {
                    kind: e.target.value as WorkflowInput['kind'],
                  }),
                )
              }
            >
              <option value="text">text</option>
              <option value="files">files</option>
              <option value="enum">enum</option>
              <option value="git">git</option>
              <option value="upload">upload</option>
            </select>
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
              <option value="port-not-empty">port-not-empty</option>
              <option value="port-equals">port-equals</option>
              <option value="port-count-lt">port-count-lt</option>
            </select>
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
              const candidates = loopMemberCandidates(node, definition.nodes, agents)
              const currentCand = candidates.find((c) => c.nodeId === exitNodeId)
              const nodeIdInvalid = exitNodeId.length > 0 && currentCand === undefined
              const portCandidates = currentCand?.outputPorts ?? []
              const portInvalid = exitPortName.length > 0 && !portCandidates.includes(exitPortName)
              return (
                <div className="form-grid form-grid--two">
                  <div>
                    <select
                      className={`form-input ${nodeIdInvalid ? 'form-input--invalid' : ''}`}
                      value={exitNodeId}
                      onChange={(e) => updateExit({ nodeId: e.target.value })}
                      data-testid="loop-exit-node-select"
                    >
                      <option value="">{t('inspector.loopExitNodeIdSelect')}</option>
                      {candidates.map((c) => (
                        <option key={c.nodeId} value={c.nodeId}>
                          {c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId}
                        </option>
                      ))}
                      {nodeIdInvalid ? (
                        <option value={exitNodeId}>{exitNodeId} (missing)</option>
                      ) : null}
                    </select>
                    {nodeIdInvalid ? (
                      <div className="form-input__error">
                        {t('inspector.loopExitInvalidNodeId', { nodeId: exitNodeId })}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <select
                      className={`form-input ${portInvalid ? 'form-input--invalid' : ''}`}
                      value={exitPortName}
                      onChange={(e) => updateExit({ portName: e.target.value })}
                      disabled={exitNodeId.length === 0}
                      data-testid="loop-exit-port-select"
                    >
                      <option value="">{t('inspector.loopExitPortNameSelect')}</option>
                      {portCandidates.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      {portInvalid ? (
                        <option value={exitPortName}>{exitPortName} (missing)</option>
                      ) : null}
                    </select>
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
                const candidates = loopMemberCandidates(node, definition.nodes, agents)
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
                    <select
                      className={`form-input form-input--mono ${bindNodeInvalid ? 'form-input--invalid' : ''}`}
                      value={b.bind.nodeId}
                      onChange={(e) => {
                        const copy = [...bindings]
                        copy[i] = { ...b, bind: { ...b.bind, nodeId: e.target.value } }
                        setBindings(copy)
                      }}
                    >
                      <option value="">{t('inspector.loopExitNodeIdSelect')}</option>
                      {candidates.map((c) => (
                        <option key={c.nodeId} value={c.nodeId}>
                          {c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId}
                        </option>
                      ))}
                      {bindNodeInvalid ? (
                        <option value={b.bind.nodeId}>{b.bind.nodeId} (missing)</option>
                      ) : null}
                    </select>
                    <select
                      className={`form-input form-input--mono ${bindPortInvalid ? 'form-input--invalid' : ''}`}
                      value={b.bind.portName}
                      onChange={(e) => {
                        const copy = [...bindings]
                        copy[i] = { ...b, bind: { ...b.bind, portName: e.target.value } }
                        setBindings(copy)
                      }}
                      disabled={b.bind.nodeId.length === 0}
                    >
                      <option value="">{t('inspector.loopExitPortNameSelect')}</option>
                      {bindPortCandidates.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      {bindPortInvalid ? (
                        <option value={b.bind.portName}>{b.bind.portName} (missing)</option>
                      ) : null}
                    </select>
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
      const title = typeof rec.title === 'string' ? rec.title : ''
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
          <Field label={t('inspector.fieldReviewTitle')} hint={t('inspector.fieldReviewTitleHint')}>
            <TextInput value={title} onChange={(v) => patchReview({ title: v })} />
          </Field>
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
            <select
              className="form-input"
              value={inputSource.nodeId ?? ''}
              onChange={(e) =>
                patchReviewInputSource({
                  nodeId: e.target.value,
                  portName: inputSource.portName ?? '',
                })
              }
            >
              <option value="">—</option>
              {upstreamCandidates.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
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
      const title = typeof rec.title === 'string' ? rec.title : ''
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
          <Field
            label={t('inspector.fieldClarifyTitle')}
            hint={t('inspector.fieldClarifyTitleHint')}
          >
            <TextInput value={title} onChange={(v) => patchClarify({ title: v })} />
          </Field>
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
          >
            <div
              className="segmented"
              role="radiogroup"
              aria-label={t('inspector.fieldClarifySessionMode')}
              data-testid="clarify-session-mode"
            >
              {(['isolated', 'inline'] as const).map((mode) => {
                const active = (rec.sessionMode ?? 'isolated') === mode
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
      const selectedAgent = agents.find((a) => a.name === agentName)
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
                definition={definition}
                agents={agents}
                selfNodeId={node.id}
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {t('inspector.sourcePortDragHint')}
              </p>
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
            <MissingRefList template={promptTemplate} inputPorts={ports.inputs} />
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
            <Field
              label={t('inspector.fieldModelOverride')}
              hint={
                selectedAgent?.model
                  ? t('inspector.fieldModelOverrideHint', { model: selectedAgent.model })
                  : undefined
              }
            >
              <ModelSelect
                value={
                  typeof overrides.model === 'string'
                    ? overrides.model
                    : (selectedAgent?.model ?? undefined)
                }
                onChange={(v) => update({ overrides: { ...overrides, model: v } })}
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

/**
 * Candidate upstream nodes an `agent-multi` can shard over. Each entry is
 * a real node that produces at least one output port, sorted by node id
 * for stable rendering. The agent-multi node itself is excluded (you
 * can't fan-out over your own output — the validator rejects it
 * downstream anyway, and offering it as an option just invites the
 * `agent-multi-source-port-missing` we're trying to prevent).
 *
 * Exported for unit tests.
 */
export function sourcePortOptions(
  definition: WorkflowDefinition,
  agents: Agent[],
  selfNodeId: string,
): Array<{ nodeId: string; kind: string; outputs: string[] }> {
  const agentByName = new Map(agents.map((a) => [a.name, a]))
  const out: Array<{ nodeId: string; kind: string; outputs: string[] }> = []
  for (const n of definition.nodes) {
    if (n.id === selfNodeId) continue
    const { outputs } = computePorts(n, agentByName, definition)
    if (outputs.length === 0) continue
    out.push({ nodeId: n.id, kind: n.kind, outputs })
  }
  out.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  return out
}

function SourcePortField({
  value,
  onChange,
  definition,
  agents,
  selfNodeId,
}: {
  value: { nodeId?: string; portName?: string }
  onChange: (next: { nodeId: string; portName: string }) => void
  definition: WorkflowDefinition
  agents: Agent[]
  selfNodeId: string
}) {
  const { t } = useTranslation()
  const options = sourcePortOptions(definition, agents, selfNodeId)
  const currentNodeId = value.nodeId ?? ''
  const currentPort = value.portName ?? ''
  const matched = options.find((o) => o.nodeId === currentNodeId)
  // Show the saved-but-unresolvable selection inline as a "(missing)"
  // option so the user can SEE the broken state instead of silently
  // seeing the dropdown jump to the placeholder — they'd otherwise lose
  // the breadcrumb that pointed them to the bad value in the first place.
  const showOrphanNode = currentNodeId !== '' && matched === undefined
  const portList = matched?.outputs ?? []
  const showOrphanPort =
    currentPort !== '' && matched !== undefined && !portList.includes(currentPort)

  return (
    <div className="form-grid form-grid--cols-2">
      <select
        className="form-input"
        value={currentNodeId}
        onChange={(e) => {
          const nextId = e.target.value
          const nextOpt = options.find((o) => o.nodeId === nextId)
          // Keep the existing port name when the new node also exposes
          // it; otherwise reset so the user is forced to make a fresh
          // choice instead of carrying a stale port forward.
          const keepPort =
            currentPort !== '' && nextOpt !== undefined && nextOpt.outputs.includes(currentPort)
          onChange({ nodeId: nextId, portName: keepPort ? currentPort : '' })
        }}
      >
        <option value="">{t('inspector.sourcePortNodePlaceholder')}</option>
        {options.map((o) => (
          <option key={o.nodeId} value={o.nodeId}>
            {o.nodeId} ({o.kind})
          </option>
        ))}
        {showOrphanNode && (
          <option
            value={currentNodeId}
          >{`${currentNodeId} ${t('inspector.sourcePortMissingSuffix')}`}</option>
        )}
      </select>
      <select
        className="form-input"
        value={currentPort}
        onChange={(e) => onChange({ nodeId: currentNodeId, portName: e.target.value })}
        disabled={currentNodeId === '' || (matched === undefined && !showOrphanNode)}
      >
        <option value="">{t('inspector.sourcePortPlaceholder')}</option>
        {portList.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {showOrphanPort && (
          <option
            value={currentPort}
          >{`${currentPort} ${t('inspector.sourcePortMissingSuffix')}`}</option>
        )}
      </select>
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
