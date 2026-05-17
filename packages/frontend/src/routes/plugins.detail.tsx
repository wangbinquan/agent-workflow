// RFC-031 — /plugins/$id. Matches /agents/$name and /mcps/$name shape:
// title row with Save + Delete buttons, PluginFields body. Name is locked
// once persisted — renames go through POST /api/plugins/:id/rename (no
// UI hook yet; same v1 stance as the other resources).
//
// "Upgrade" / "Check for update" buttons live on the list page, not here:
// the detail page is the *edit* surface (spec / options / description /
// enabled), upgrade is a one-shot action that the operator usually triggers
// from the table row alongside delete.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { PluginFields } from '@/components/PluginFields'
import {
  buildUpdatePayload,
  EMPTY_PLUGIN_FORM,
  pluginToForm,
  type PluginFormState,
} from '@/lib/plugin-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins/$id',
  component: PluginDetailPage,
})

function PluginDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<PluginFormState>(EMPTY_PLUGIN_FORM)
  const [loaded, setLoaded] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const query = useQuery<Plugin>({
    queryKey: ['plugins', id],
    queryFn: ({ signal }) => api.get(`/api/plugins/${encodeURIComponent(id)}`, undefined, signal),
  })

  useEffect(() => {
    if (!loaded && query.data !== undefined) {
      setForm(pluginToForm(query.data))
      setLoaded(true)
    }
  }, [loaded, query.data])

  const save = useMutation({
    mutationFn: async (): Promise<Plugin> => {
      if (query.data === undefined) throw new Error('plugin-not-loaded')
      const built = buildUpdatePayload(form, query.data)
      if (!built.ok) {
        setErrors(built.errors)
        throw new Error('form-invalid')
      }
      setErrors({})
      return api.put<Plugin>(`/api/plugins/${encodeURIComponent(id)}`, built.payload)
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      qc.setQueryData(['plugins', id], p)
      navigate({ to: '/plugins' })
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/plugins/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      navigate({ to: '/plugins' })
    },
  })

  if (query.isLoading) return <div className="page muted">{t('common.loading')}</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeError(query.error)}</div>

  const displayName = query.data?.name ?? id

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{displayName}</h1>
          <p className="page__hint">{t('plugins.detailHint')}</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || !loaded}
            onClick={() => save.mutate()}
            data-testid="plugin-save-button"
          >
            {save.isPending ? t('plugins.saving') : t('plugins.saveButton')}
          </button>
          <ConfirmButton
            label={t('common.delete')}
            onConfirm={() => del.mutateAsync()}
            danger
            disabled={del.isPending}
          />
          {save.error !== null && save.error !== undefined && (
            <span className="form-actions__error">{describeError(save.error)}</span>
          )}
          {del.error !== null && del.error !== undefined && (
            <span className="form-actions__error">{describeError(del.error)}</span>
          )}
        </div>
      </header>

      <PluginFields value={form} onChange={setForm} nameLocked errors={errors} />
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
