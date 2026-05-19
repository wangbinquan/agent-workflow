// Simple chip input for string arrays (outputs / skills lists).
// Enter or comma commits the pending token; Backspace on empty input deletes
// the last chip. No drag-reorder for M1; that's a P-1-17 stretch.

import { useState, type KeyboardEvent } from 'react'

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
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | null>(null)

  function commit(raw: string) {
    const token = raw.trim()
    if (token === '') return
    if (value.includes(token)) {
      setError(`duplicate: ${token}`)
      return
    }
    if (validate) {
      const err = validate(token)
      if (err !== null) {
        setError(err)
        return
      }
    }
    onChange([...value, token])
    setPending('')
    setError(null)
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(pending)
    } else if (e.key === 'Backspace' && pending === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

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
              aria-label={`Remove ${token}`}
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
          value={pending}
          onChange={(e) => {
            setPending(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKey}
          onBlur={() => commit(pending)}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          data-testid={testidPrefix !== undefined ? `${testidPrefix}-input` : undefined}
        />
      </div>
      {error !== null && <div className="chips-input__error">{error}</div>}
    </div>
  )
}
