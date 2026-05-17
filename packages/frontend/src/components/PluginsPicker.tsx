// RFC-031 — same shape as McpsPicker, but pointed at /api/plugins. Lets the
// user pick from existing plugin rows instead of typing names by hand. Falls
// back to a plain ChipsInput when the plugin list fails to load so the agent
// form stays usable.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'

export const PLUGINS_QUERY_KEY = ['plugins'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function PluginsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Plugin[]>({
    queryKey: PLUGINS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/plugins', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    // Only offer enabled plugins; the save-time guard rejects references to
    // disabled rows so suggesting them would mislead the operator.
    return (list.data ?? []).filter((p) => p.enabled && !existing.has(p.name))
  }, [list.data, value])

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
          data-testid="plugins-picker-select"
        >
          <option value="">
            {list.isLoading
              ? t('agentForm.pluginsPickerLoading')
              : available.length === 0
                ? t('agentForm.pluginsPickerEmpty')
                : t('agentForm.pluginsPickerLabel')}
          </option>
          {available.map((p) => (
            <option key={p.name} value={p.name}>
              {p.description ? `${p.name} — ${p.description}` : p.name}
              {p.resolvedVersion !== null ? ` (${p.resolvedVersion})` : ''}
            </option>
          ))}
        </select>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.pluginsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
