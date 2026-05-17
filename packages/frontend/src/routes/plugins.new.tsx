// RFC-031 — /plugins/new. Matches /agents/new, /skills/new, /mcps/new
// shape: page + page__header + PluginFields + single primary action in
// form-actions. No cancel button (sidebar / browser back navigate away).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { PluginFields } from '@/components/PluginFields'
import { buildCreatePayload, EMPTY_PLUGIN_FORM, type PluginFormState } from '@/lib/plugin-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins/new',
  component: PluginCreatePage,
})

function PluginCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<PluginFormState>(EMPTY_PLUGIN_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const create = useMutation({
    mutationFn: async (): Promise<Plugin> => {
      const built = buildCreatePayload(form)
      if (!built.ok) {
        setErrors(built.errors)
        throw new Error('form-invalid')
      }
      setErrors({})
      return api.post<Plugin>('/api/plugins', built.payload)
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      navigate({ to: '/plugins/$id', params: { id: p.id } })
    },
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('plugins.newTitle')}</h1>
        <p className="page__hint">{t('plugins.newHint')}</p>
      </header>

      <PluginFields value={form} onChange={setForm} errors={errors} />

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || form.name === ''}
          onClick={() => create.mutate()}
          data-testid="plugin-save-button"
        >
          {create.isPending ? t('plugins.creating') : t('plugins.createButton')}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeError(create.error)}</span>
        )}
      </div>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
