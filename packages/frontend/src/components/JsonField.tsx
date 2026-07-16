// Controlled raw JSON textarea used by AgentForm's pass-through object fields.
//
// RFC-201 T3.1: raw text is route-owned alongside the last parse result and
// validation error. An invalid edit must therefore remain visible to the
// owning route (dirty guard, Save/Create gating, tab badge) instead of being
// trapped in this component while the parent keeps the previous valid object.

import { useId, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { TextArea } from './Form'

export interface JsonFieldChange<T = Record<string, unknown>> {
  raw: string
  parsed?: T
  error?: string
}

interface JsonFieldProps {
  state: JsonFieldChange<Record<string, unknown>>
  onChange: (next: JsonFieldChange<Record<string, unknown>>) => void
  rows?: number
  placeholder?: string
  id?: string
  textareaRef?: Ref<HTMLTextAreaElement>
  'data-testid'?: string
}

export function jsonFieldChangeFromValue(
  value: Record<string, unknown>,
): JsonFieldChange<Record<string, unknown>> {
  return { raw: stringify(value), parsed: value }
}

export function JsonField({
  state,
  onChange,
  rows = 6,
  placeholder,
  id,
  textareaRef,
  'data-testid': testid,
}: JsonFieldProps) {
  const { t } = useTranslation()
  const generatedId = useId()
  const textareaId = id ?? `${generatedId}-input`
  const errorId = `${textareaId}-error`

  function handleChange(raw: string) {
    if (raw.trim() === '') {
      onChange({ raw, parsed: {} })
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        onChange({
          raw,
          error: t('agentForm.jsonObjectError'),
        })
        return
      }
      onChange({ raw, parsed: parsed as Record<string, unknown> })
    } catch {
      onChange({
        raw,
        error: t('agentForm.jsonSyntaxError'),
      })
    }
  }

  return (
    <div className="json-field">
      <TextArea
        id={textareaId}
        value={state.raw}
        onChange={handleChange}
        rows={rows}
        placeholder={placeholder}
        monospace
        textareaRef={textareaRef}
        aria-invalid={state.error === undefined ? undefined : true}
        aria-describedby={state.error === undefined ? undefined : errorId}
        aria-errormessage={state.error === undefined ? undefined : errorId}
        data-testid={testid}
      />
      {state.error !== undefined && (
        <div id={errorId} className="json-field__error">
          {state.error}
        </div>
      )}
    </div>
  )
}

function stringify(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) return ''
  return JSON.stringify(value, null, 2)
}
