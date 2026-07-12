// MCP create page — the inline "new" view of the /mcps split page.
//
// RFC-169 (T15/T-D10): child route under the /mcps layout (path '/new'). Single
// config group → no tab strip. Light header with the create button.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateMcp, Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { McpFields } from '@/components/McpFields'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NEW_CARD_KEY, useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { buildCreatePayload, EMPTY_LOCAL_FORM, type McpFormState } from '@/lib/mcp-form'
import { Route as mcpsRoute } from './mcps'

export const Route = createRoute({
  getParentRoute: () => mcpsRoute,
  path: '/new',
  component: McpCreatePage,
})

function McpCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { dirty } = useDirtyBaseline(form, EMPTY_LOCAL_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty)

  const create = useMutation({
    mutationFn: (payload: CreateMcp): Promise<Mcp> => api.post<Mcp>('/api/mcps', payload),
    onSuccess: (m) => {
      report(NEW_CARD_KEY, false)
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      navigate({ to: '/mcps/$name', params: { name: m.name } })
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
          <h2>{t('mcps.newTitle')}</h2>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={create.isPending || form.name === ''}
            onClick={submit}
            data-testid="mcp-save-button"
          >
            {create.isPending ? t('common.creating') : t('mcps.createButton')}
          </button>
        </div>
      </header>
      {create.error !== null && create.error !== undefined && <ErrorBanner error={create.error} />}
      <div className="split__detail-body">
        <McpFields value={form} onChange={setForm} errors={errors} />
      </div>
    </div>
  )
}
