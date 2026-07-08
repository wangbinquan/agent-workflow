// Per-port editor for agent.outputs + agent.outputKinds. Each declared port
// is a row of (name, KindSelect, remove). New ports are added via an inline
// input that mirrors ChipsInput's Enter/Backspace semantics. Completes RFC-005
// design.md §line 120; RFC-080 PR-B swaps the bespoke 3-option native dropdown
// for the shared KindSelect so the full kind grammar (path / list / signal) is
// selectable and the option set derives from the OUTPUT_KIND_UI catalog.
// RFC-151 PR-1 — the add-input's commit logic (Enter/comma commit, Backspace
// delete-last, dedup, pattern validate) no longer forks ChipsInput's: it is
// the shared `useChipsCommit` hook. Rendering (per-port rows + KindSelect)
// stays bespoke — this editor is NOT a plain chips list.

import { useTranslation } from 'react-i18next'
import { DEFAULT_OUTPUT_KIND, type AgentOutputKindsMap } from '@agent-workflow/shared'
import { useChipsCommit } from './ChipsInput'
import { KindSelect } from './KindSelect'

const PORT_NAME_RE = /^[a-z][a-z0-9_]*$/

interface OutputsEditorProps {
  outputs: string[]
  outputKinds?: AgentOutputKindsMap
  onChange: (outputs: string[], outputKinds: AgentOutputKindsMap | undefined) => void
  placeholder?: string
}

function compact(map: AgentOutputKindsMap): AgentOutputKindsMap | undefined {
  return Object.keys(map).length === 0 ? undefined : map
}

export function OutputsEditor({ outputs, outputKinds, onChange, placeholder }: OutputsEditorProps) {
  const { t } = useTranslation()
  const kinds: AgentOutputKindsMap = outputKinds ?? {}

  function removeAt(idx: number) {
    const name = outputs[idx]
    const nextOutputs = outputs.filter((_, i) => i !== idx)
    if (name !== undefined && kinds[name] !== undefined) {
      const { [name]: _drop, ...rest } = kinds
      onChange(nextOutputs, compact(rest))
    } else {
      onChange(nextOutputs, outputKinds)
    }
  }

  const chips = useChipsCommit({
    values: outputs,
    validate: (token) => (PORT_NAME_RE.test(token) ? null : t('agentForm.outputsValidate')),
    // Adding a port never touches outputKinds (new ports default to string).
    onCommit: (token) => onChange([...outputs, token], outputKinds),
    // Backspace on empty input removes the last port AND its kind entry.
    onRemoveLast: () => removeAt(outputs.length - 1),
  })

  function setKind(name: string, kind: string) {
    if (kind === DEFAULT_OUTPUT_KIND) {
      if (kinds[name] === undefined) return
      const { [name]: _drop, ...rest } = kinds
      onChange(outputs, compact(rest))
    } else {
      onChange(outputs, { ...kinds, [name]: kind })
    }
  }

  return (
    <div className="outputs-editor">
      {outputs.length > 0 && (
        <ul className="outputs-editor__list">
          {outputs.map((name, idx) => {
            const kind: string = kinds[name] ?? DEFAULT_OUTPUT_KIND
            return (
              <li key={`${name}-${idx}`} className="outputs-editor__row">
                <span className="outputs-editor__name">{name}</span>
                <KindSelect
                  value={kind}
                  onChange={(k) => setKind(name, k)}
                  ariaLabel={t('agentForm.outputKindLabel', { port: name })}
                  testidPrefix={`output-kind-${name}`}
                />
                <button
                  type="button"
                  className="chip__remove outputs-editor__remove"
                  onClick={() => removeAt(idx)}
                  aria-label={t('common.removeAria', { label: name })}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <input
        className="form-input outputs-editor__add"
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
