// RFC-001: provider-grouped dropdown + custom text fallback for the Default
// Model field on the Settings → Runtime tab. Backs onto GET /api/runtime/models
// with a "Refresh" button that forwards ?refresh=1 (which makes the daemon
// call `opencode models --refresh`).
//
// Value contract matches the underlying Config.defaultModel:
//   string  - either a known "provider/modelID" or a custom user input
//   undefined - empty (no default model set)
//
// When the persisted value isn't in the loaded list, the component
// auto-switches into "custom" mode and prefills the text input — so users
// can keep using models the daemon's cache hasn't picked up yet.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OpencodeModel, RuntimeModelsResponse } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { TextInput } from '@/components/Form'

export const RUNTIME_MODELS_QUERY_KEY = ['runtime', 'models'] as const

const CUSTOM_OPTION = '__custom__'

interface Props {
  value: string | undefined
  onChange: (next: string | undefined) => void
}

export function ModelSelect({ value, onChange }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery<RuntimeModelsResponse>({
    queryKey: RUNTIME_MODELS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtime/models', undefined, signal),
    staleTime: Infinity,
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: () =>
      api.get<RuntimeModelsResponse>('/api/runtime/models', { refresh: '1' }),
    onSuccess: (next) => {
      qc.setQueryData(RUNTIME_MODELS_QUERY_KEY, next)
    },
  })

  const grouped = useMemo(() => groupByProvider(list.data?.models ?? []), [list.data])
  const knownIds = useMemo(() => new Set((list.data?.models ?? []).map((m) => m.id)), [list.data])

  const failed = list.error !== null && list.error !== undefined
  const isCustom = isCustomValue(value, knownIds, failed)
  const [customText, setCustomText] = useState<string>(isCustom ? (value ?? '') : '')

  useEffect(() => {
    if (isCustom) setCustomText(value ?? '')
  }, [value, isCustom])

  if (failed) {
    return (
      <div>
        <TextInput
          value={value ?? ''}
          onChange={(v) => onChange(v === '' ? undefined : v)}
          placeholder="anthropic/claude-sonnet-4-6"
        />
        <p
          style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}
          className="muted"
          role="alert"
        >
          {t('settingsForm.modelLoadFailed')}
        </p>
      </div>
    )
  }

  const selectValue = value === undefined || value === '' ? '' : isCustom ? CUSTOM_OPTION : value

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          className="form-input"
          value={selectValue}
          disabled={list.isLoading}
          onChange={(e) => {
            const v = e.target.value
            if (v === '') {
              onChange(undefined)
              return
            }
            if (v === CUSTOM_OPTION) {
              onChange(customText === '' ? undefined : customText)
              return
            }
            onChange(v)
          }}
          style={{ flex: 1 }}
        >
          <option value="">{list.isLoading ? t('settingsForm.modelLoading') : t('settingsForm.modelEmpty')}</option>
          {grouped.map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.modelID}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM_OPTION}>{t('settingsForm.modelCustom')}</option>
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => refresh.mutate()}
          disabled={list.isLoading || refresh.isPending}
          style={{ fontSize: 12 }}
        >
          {refresh.isPending ? t('settingsForm.modelLoading') : t('settingsForm.modelRefresh')}
        </button>
      </div>
      {isCustom && (
        <div style={{ marginTop: 6 }}>
          <TextInput
            value={customText}
            onChange={(v) => {
              setCustomText(v)
              onChange(v === '' ? undefined : v)
            }}
            placeholder={t('settingsForm.modelCustomPlaceholder')}
          />
        </div>
      )}
      {refresh.error instanceof ApiError && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {refresh.error.message}
        </p>
      )}
    </div>
  )
}

export function isCustomValue(
  value: string | undefined,
  knownIds: Set<string>,
  failed: boolean,
): boolean {
  if (value === undefined || value === '') return false
  if (failed) return false
  return !knownIds.has(value)
}

export function groupByProvider(models: OpencodeModel[]): Array<[string, OpencodeModel[]]> {
  const map = new Map<string, OpencodeModel[]>()
  for (const m of models) {
    const arr = map.get(m.provider) ?? []
    arr.push(m)
    map.set(m.provider, arr)
  }
  // opencode CLI sorts opencode* providers first, then alphabetical. Mirror.
  const entries = Array.from(map.entries())
  entries.sort(([a], [b]) => {
    const aIsOpencode = a.startsWith('opencode')
    const bIsOpencode = b.startsWith('opencode')
    if (aIsOpencode && !bIsOpencode) return -1
    if (!aIsOpencode && bIsOpencode) return 1
    return a.localeCompare(b)
  })
  return entries
}
