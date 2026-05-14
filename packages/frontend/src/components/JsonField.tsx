// Raw JSON textarea + parse status. Used for agent.permission and
// agent.frontmatterExtra — both are pass-through `Record<string, unknown>`
// fields where the user knows opencode-shape better than we can validate.
//
// Local string state preserves keystrokes that aren't yet valid JSON. The
// parent only gets called with parsed values once the input parses cleanly.

import { useEffect, useState } from 'react'
import { TextArea } from './Form'

interface JsonFieldProps {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  rows?: number
  placeholder?: string
}

export function JsonField({ value, onChange, rows = 6, placeholder }: JsonFieldProps) {
  const [draft, setDraft] = useState(() => stringify(value))
  const [error, setError] = useState<string | null>(null)
  const [externalSync, setExternalSync] = useState(() => stringify(value))

  // Reset the textarea when the parent value changes from outside (e.g. on
  // initial load after fetch). Avoid clobbering an in-progress edit when the
  // value didn't actually change.
  useEffect(() => {
    const next = stringify(value)
    if (next !== externalSync) {
      setDraft(next)
      setExternalSync(next)
      setError(null)
    }
  }, [value, externalSync])

  function handleChange(next: string) {
    setDraft(next)
    if (next.trim() === '') {
      onChange({})
      setError(null)
      return
    }
    try {
      const parsed = JSON.parse(next)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('must be a JSON object')
        return
      }
      setError(null)
      onChange(parsed as Record<string, unknown>)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'invalid JSON')
    }
  }

  return (
    <div className="json-field">
      <TextArea
        value={draft}
        onChange={handleChange}
        rows={rows}
        placeholder={placeholder}
        monospace
      />
      {error !== null && <div className="json-field__error">{error}</div>}
    </div>
  )
}

function stringify(v: Record<string, unknown>): string {
  if (Object.keys(v).length === 0) return ''
  return JSON.stringify(v, null, 2)
}
