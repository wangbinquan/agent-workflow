// Plugin create page — the inline "new" view of the /plugins split page.
//
// RFC-169 (T17/T-D10): child route under the /plugins layout (path '/new').
// Single config group → no tab strip. Light header with the create button.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreatePlugin, Plugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { PluginFields } from '@/components/PluginFields'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NEW_CARD_KEY, useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { buildCreatePayload, EMPTY_PLUGIN_FORM, type PluginFormState } from '@/lib/plugin-form'
import { Route as pluginsRoute } from './plugins'

export const Route = createRoute({
  getParentRoute: () => pluginsRoute,
  path: '/new',
  component: PluginCreatePage,
})

function PluginCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()
  const [form, setForm] = useState<PluginFormState>(EMPTY_PLUGIN_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { dirty } = useDirtyBaseline(form, EMPTY_PLUGIN_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty)

  const create = useMutation({
    mutationFn: (payload: CreatePlugin): Promise<Plugin> =>
      api.post<Plugin>('/api/plugins', payload),
    onSuccess: (p) => {
      report(NEW_CARD_KEY, false)
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      navigate({ to: '/plugins/$id', params: { id: p.id } })
    },
  })

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
    <div className="agent-new">
      <header className="page__header page__header--row">
        <div>
          <h2>{t('plugins.newTitle')}</h2>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={create.isPending || form.name === ''}
            onClick={submit}
            data-testid="plugin-save-button"
          >
            {create.isPending ? t('plugins.creating') : t('plugins.createButton')}
          </button>
        </div>
      </header>
      {create.error !== null && create.error !== undefined && <ErrorBanner error={create.error} />}
      <div className="split__detail-body">
        <PluginFields value={form} onChange={setForm} errors={errors} />
      </div>
    </div>
  )
}
