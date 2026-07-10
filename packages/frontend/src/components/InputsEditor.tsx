// RFC-166 — per-port editor for agent.inputs (declarative INPUT ports). Each
// declared port is a row of (name, KindSelect, required toggle, remove); new
// ports are added via an inline input reusing ChipsInput's Enter/comma/Backspace
// commit semantics (shared `useChipsCommit` hook — same as OutputsEditor).
//
// Symmetric to OutputsEditor but over the richer AgentInputPort shape
// ({name, kind, required?, description?}): kind is inlined (no sidecar map) and
// there is a per-port `required` flag. `description` is preserved verbatim on
// every port (spread) even though this compact editor does not surface it, so
// an imported agent.md's port descriptions survive a round-trip through the UI.
//
// Duplicate names are rejected at commit (useChipsCommit dedup), matching the
// AgentInputPortsSchema uniqueness refine so the UI never produces a body the
// server would 422.

import { useTranslation } from 'react-i18next'
import { DEFAULT_OUTPUT_KIND, type AgentInputPort } from '@agent-workflow/shared'
import { useChipsCommit } from './ChipsInput'
import { KindSelect } from './KindSelect'

const PORT_NAME_RE = /^[a-z][a-z0-9_]*$/

interface InputsEditorProps {
  inputs: AgentInputPort[]
  onChange: (inputs: AgentInputPort[]) => void
  placeholder?: string
}

export function InputsEditor({ inputs, onChange, placeholder }: InputsEditorProps) {
  const { t } = useTranslation()

  function removeAt(idx: number) {
    onChange(inputs.filter((_, i) => i !== idx))
  }
  function patchAt(idx: number, patch: Partial<AgentInputPort>) {
    onChange(inputs.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }

  const chips = useChipsCommit({
    values: inputs.map((p) => p.name),
    validate: (token) => (PORT_NAME_RE.test(token) ? null : t('agentForm.inputsValidate')),
    // New ports default to the base string kind; kind/required are edited inline.
    onCommit: (token) => onChange([...inputs, { name: token, kind: DEFAULT_OUTPUT_KIND }]),
    // Backspace on empty input removes the last port.
    onRemoveLast: () => removeAt(inputs.length - 1),
  })

  return (
    <div className="inputs-editor">
      {inputs.length > 0 && (
        <ul className="inputs-editor__list">
          {inputs.map((port, idx) => {
            const kind: string = port.kind === '' ? DEFAULT_OUTPUT_KIND : port.kind
            return (
              <li key={`${port.name}-${idx}`} className="inputs-editor__row">
                <span className="inputs-editor__name">{port.name}</span>
                <KindSelect
                  value={kind}
                  onChange={(k) => patchAt(idx, { kind: k })}
                  ariaLabel={t('agentForm.inputKindLabel', { port: port.name })}
                  testidPrefix={`input-kind-${port.name}`}
                />
                <label className="inputs-editor__required">
                  <input
                    type="checkbox"
                    checked={port.required === true}
                    onChange={(e) => patchAt(idx, { required: e.target.checked })}
                    aria-label={t('agentForm.inputRequiredLabel', { port: port.name })}
                  />
                  {t('agentForm.inputRequired')}
                </label>
                <button
                  type="button"
                  className="chip__remove inputs-editor__remove"
                  onClick={() => removeAt(idx)}
                  aria-label={t('common.removeAria', { label: port.name })}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <input
        className="form-input inputs-editor__add"
        value={chips.pending}
        onChange={(e) => chips.setPendingValue(e.target.value)}
        onKeyDown={chips.handleKeyDown}
        onBlur={chips.handleBlur}
        placeholder={placeholder}
      />
      {chips.error !== null && <div className="chips-input__error">{chips.error}</div>}
    </div>
  )
}
