// RFC-001: provider-grouped dropdown + custom text fallback for picking a model
// id. Backs onto GET /api/runtime/models with a "Refresh" button that forwards
// ?refresh=1 (which makes the daemon call `opencode models --refresh`).
//
// Live callers (RFC-113/115): Settings → commit&push model + memory-distill
// model, and the runtime profile model field in RuntimeList / RuntimeFormDialog.
// (The old Settings "Default Model" field / Config.defaultModel were removed.)
//
// Value contract — a `string | undefined`:
//   string  - either a known "provider/modelID" or a custom user input
//   undefined - empty (no model selected)
//
// When the persisted value isn't in the loaded list, the component
// auto-switches into "custom" mode and prefills the text input — so users
// can keep using models the daemon's cache hasn't picked up yet.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OpencodeModel, RuntimeModelsResponse } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { Select, type SelectOption } from '@/components/Select'
import { resolveApiError } from '@/i18n/errors'

export const RUNTIME_MODELS_QUERY_KEY = ['runtime', 'models'] as const
/**
 * RFC-111: the claude-code model list is a separate cache entry (the backend
 * returns a curated static list at `/api/runtime/models?runtime=claude`). The
 * extra `'claude'` segment keeps it from colliding with the live opencode list.
 */
export const RUNTIME_CLAUDE_MODELS_QUERY_KEY = ['runtime', 'models', 'claude'] as const

const CUSTOM_OPTION = '__custom__'

function modelLoadDisplayError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error
  const resolved = resolveApiError(error)
  // ErrorBanner resolves the stable code again so its existing hint support is
  // retained. Replace the wire message and omit wire details first: model
  // inventory errors are a product boundary, not a raw backend-text console.
  return new ApiError(error.status, error.code, resolved.title)
}

interface Props {
  value: string | undefined
  onChange: (next: string | undefined) => void
  /**
   * RFC-111: which runtime's model namespace to list. `'opencode'` (default)
   * is byte-identical to the pre-RFC-111 behavior; `'claude'` swaps the query
   * key + appends `?runtime=claude` so the curated Claude Code list loads.
   */
  runtime?: 'opencode' | 'claude'
  /**
   * RFC-114: list models for a SPECIFIC registered runtime (its binary), via
   * `?runtime=<name>`. Overrides `runtime` when set. Used by RuntimeFormDialog
   * when editing a runtime so a custom opencode fork shows ITS models. Settings
   * (no `runtimeName`) keeps the protocol-based default fetch byte-identical.
   */
  runtimeName?: string
}

export function ModelSelect({ value, onChange, runtime = 'opencode', runtimeName }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isClaude = runtime === 'claude'
  // RFC-114: a named runtime wins; else the protocol namespace; else default.
  const queryParam: Record<string, string> | undefined =
    runtimeName !== undefined
      ? { runtime: runtimeName }
      : isClaude
        ? { runtime: 'claude' }
        : undefined
  const queryKey =
    runtimeName !== undefined
      ? (['runtime', 'models', 'rt', runtimeName] as const)
      : isClaude
        ? RUNTIME_CLAUDE_MODELS_QUERY_KEY
        : RUNTIME_MODELS_QUERY_KEY
  const list = useQuery<RuntimeModelsResponse>({
    queryKey,
    queryFn: ({ signal }) => api.get('/api/runtime/models', queryParam, signal),
    staleTime: Infinity,
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: () =>
      api.get<RuntimeModelsResponse>('/api/runtime/models', {
        ...(queryParam ?? {}),
        refresh: '1',
      }),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next)
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
        <ErrorBanner error={modelLoadDisplayError(list.error)} testid="model-select-load-error" />
      </div>
    )
  }

  const selectValue = value === undefined || value === '' ? '' : isCustom ? CUSTOM_OPTION : value

  // Provider grouping moves from native <optgroup> to the shared Select's
  // `group` field (RFC-036 extension). The leading empty row and the trailing
  // custom sentinel stay ungrouped so they render without a header.
  const modelOptions: ReadonlyArray<SelectOption<string>> = [
    {
      value: '',
      label: list.isLoading ? t('settingsForm.modelLoading') : t('settingsForm.modelEmpty'),
    },
    ...grouped.flatMap(([provider, models]) =>
      models.map((m) => ({ value: m.id, label: m.name ?? m.modelID, group: provider })),
    ),
    { value: CUSTOM_OPTION, label: t('settingsForm.modelCustom') },
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select<string>
            value={selectValue}
            disabled={list.isLoading}
            options={modelOptions}
            onChange={(v) => {
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
          />
        </div>
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
      {refresh.error !== null && refresh.error !== undefined && (
        <ErrorBanner
          error={modelLoadDisplayError(refresh.error)}
          testid="model-select-refresh-error"
        />
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
