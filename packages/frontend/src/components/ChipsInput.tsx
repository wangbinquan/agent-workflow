// Simple chip input for string arrays (outputs / skills lists).
// Enter or comma commits the pending token; Backspace on empty input deletes
// the last chip. No drag-reorder for M1; that's a P-1-17 stretch.
//
// RFC-151 PR-1 — the token-commit core (Enter/comma commit, Backspace
// delete-last, dedup, validate) is extracted into the shared `useChipsCommit`
// hook so OutputsEditor (which renders its own per-port row UI with a
// KindSelect) reuses the exact same input semantics instead of forking them.

import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

export interface ChipsCommitOptions {
  /** Currently committed tokens — the dedup source and Backspace guard. */
  values: readonly string[]
  /** Called with the trimmed token once it passed dedup + validate. */
  onCommit: (token: string) => void
  /** Called when Backspace is pressed on an empty pending input. */
  onRemoveLast: () => void
  /** Optional extra validation; return an error message or null. */
  validate?: (token: string) => string | null
}

export interface ChipsCommitApi {
  pending: string
  error: string | null
  /** Controlled-input onChange: updates pending and clears the error. */
  setPendingValue: (v: string) => void
  commit: (raw: string) => void
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  handleBlur: () => void
}

/**
 * Shared token-commit state machine: trim → reject empty → reject duplicate
 * (i18n `common.duplicateError`) → custom validate → commit + clear pending.
 * Enter/comma commit, Backspace on empty pending removes the last token,
 * blur commits the pending token.
 */
export function useChipsCommit({
  values,
  onCommit,
  onRemoveLast,
  validate,
}: ChipsCommitOptions): ChipsCommitApi {
  const { t } = useTranslation()
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | null>(null)

  function commit(raw: string) {
    const token = raw.trim()
    if (token === '') return
    if (values.includes(token)) {
      setError(t('common.duplicateError', { token }))
      return
    }
    if (validate) {
      const err = validate(token)
      if (err !== null) {
        setError(err)
        return
      }
    }
    onCommit(token)
    setPending('')
    setError(null)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(pending)
    } else if (e.key === 'Backspace' && pending === '' && values.length > 0) {
      onRemoveLast()
    }
  }

  return {
    pending,
    error,
    setPendingValue: (v) => {
      setPending(v)
      setError(null)
    },
    commit,
    handleKeyDown,
    handleBlur: () => commit(pending),
  }
}

interface ChipsInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  validate?: (token: string) => string | null
  disabled?: boolean
  /**
   * Optional namespace for test-only data-testid attributes. When set the
   * input gets `${prefix}-input` and each chip's remove button gets
   * `${prefix}-remove-${token}`. No effect on production behavior.
   */
  testidPrefix?: string
}

export function ChipsInput({
  value,
  onChange,
  placeholder,
  validate,
  disabled,
  testidPrefix,
}: ChipsInputProps) {
  const { t } = useTranslation()
  const chips = useChipsCommit({
    values: value,
    validate,
    onCommit: (token) => onChange([...value, token]),
    onRemoveLast: () => onChange(value.slice(0, -1)),
  })

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }

  return (
    <div className="chips-input">
      <div className="chips-input__row">
        {value.map((token, i) => (
          <span key={`${token}-${i}`} className="chip">
            {token}
            <button
              type="button"
              className="chip__remove"
              onClick={() => remove(i)}
              aria-label={t('common.removeAria', { label: token })}
              disabled={disabled}
              data-testid={
                testidPrefix !== undefined ? `${testidPrefix}-remove-${token}` : undefined
              }
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="chips-input__field"
          value={chips.pending}
          onChange={(e) => chips.setPendingValue(e.target.value)}
          onKeyDown={chips.handleKeyDown}
          onBlur={chips.handleBlur}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          data-testid={testidPrefix !== undefined ? `${testidPrefix}-input` : undefined}
        />
      </div>
      {chips.error !== null && <div className="chips-input__error">{chips.error}</div>}
    </div>
  )
}
