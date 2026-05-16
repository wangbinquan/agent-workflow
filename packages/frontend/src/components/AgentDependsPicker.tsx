// RFC-022: dropdown of existing agents above the chip input. Mirror of
// SkillsPicker. Lets the form author pick the closure members from
// /api/agents instead of typing names; self-name is filtered out because
// the save-time guard refuses self-references.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'

export const AGENTS_QUERY_KEY = ['agents'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  /** Name of the agent being edited — excluded from the dropdown so the form
   *  cannot offer "select self" (which the save-time guard would reject). */
  selfName?: string
  placeholder?: string
}

export function AgentDependsPicker({ value, onChange, selfName, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Agent[]>({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    return (list.data ?? []).filter((a) => !existing.has(a.name) && a.name !== selfName)
  }, [list.data, value, selfName])

  const failed = list.error !== null && list.error !== undefined

  return (
    <div>
      {!failed && (
        <select
          className="form-input"
          value=""
          disabled={list.isLoading || available.length === 0}
          onChange={(e) => {
            const name = e.target.value
            if (!name) return
            if (!value.includes(name)) onChange([...value, name])
            e.target.value = ''
          }}
          style={{ marginBottom: 6 }}
        >
          <option value="">
            {list.isLoading
              ? t('agentForm.dependsPickerLoading')
              : available.length === 0
                ? t('agentForm.dependsPickerEmpty')
                : t('agentForm.dependsPickerLabel')}
          </option>
          {available.map((a) => (
            <option key={a.name} value={a.name}>
              {a.description ? `${a.name} — ${a.description}` : a.name}
            </option>
          ))}
        </select>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.dependsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
