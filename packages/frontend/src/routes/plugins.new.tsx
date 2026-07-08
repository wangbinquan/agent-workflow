// RFC-031 — /plugins/new. Matches /agents/new, /skills/new, /mcps/new
// shape: page + page__header + PluginFields + single primary action in
// form-actions. No cancel button (sidebar / browser back navigate away).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreatePlugin, Plugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { PluginFields } from '@/components/PluginFields'
import { describeApiError } from '@/i18n'
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
    mutationFn: (payload: CreatePlugin): Promise<Plugin> =>
      api.post<Plugin>('/api/plugins', payload),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      navigate({ to: '/plugins/$id', params: { id: p.id } })
    },
  })

  // RFC-151 PR-1 — validate before mutate; an invalid form sets inline field
  // errors only (previously a thrown validation sentinel leaked into the
  // form-actions banner as a raw untranslated string).
  function submit() {
    const built = buildCreatePayload(form)
    if (!built.ok) {
      setErrors(built.errors)
      create.reset()
      return
    }
    setErrors({})
    create.mutate(built.payload)
  }

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
          onClick={submit}
          data-testid="plugin-save-button"
        >
          {create.isPending ? t('plugins.creating') : t('plugins.createButton')}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeApiError(create.error)}</span>
        )}
      </div>
    </div>
  )
}
