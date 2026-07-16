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
import { PageHeader } from '@/components/PageHeader'
import {
  NEW_CARD_KEY,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
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
  const { beginBusy, report } = useSplitDirty()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { dirty } = useDirtyBaseline(form, EMPTY_LOCAL_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty)

  const create = useMutation({
    mutationFn: ({ payload }: { payload: CreateMcp; release: SplitBusyRelease }): Promise<Mcp> =>
      api.post<Mcp>('/api/mcps', payload),
    onSuccess: (m, { release }) => {
      report(NEW_CARD_KEY, false)
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      release()
      navigate({ to: '/mcps/$name', params: { name: m.name } })
    },
    onSettled: (_mcp, _error, { release }) => release(),
  })

  function submit() {
    const built = buildCreatePayload(form)
    if (!built.ok) {
      setErrors(built.errors)
      create.reset()
      return
    }
    setErrors({})
    if (create.isPending) return
    create.mutate({ payload: built.payload, release: beginBusy(NEW_CARD_KEY) })
  }

  return (
    <fieldset className="agent-new detail-freeze" disabled={create.isPending}>
      <PageHeader
        title={t('mcps.newTitle')}
        headingLevel={2}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            disabled={create.isPending || form.name === ''}
            onClick={submit}
            data-testid="mcp-save-button"
          >
            {create.isPending ? t('common.creating') : t('mcps.createButton')}
          </button>
        }
      />
      {create.error !== null && create.error !== undefined && <ErrorBanner error={create.error} />}
      <div className="split__detail-body">
        <McpFields value={form} onChange={setForm} errors={errors} />
      </div>
    </fieldset>
  )
}
