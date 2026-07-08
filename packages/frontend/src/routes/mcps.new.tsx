// RFC-028 — /mcps/new. Matches /agents/new and /skills/new shape: page +
// page__header + McpFields + single primary action in form-actions. No
// cancel button (sidebar / browser back navigate away).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateMcp, Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { McpFields } from '@/components/McpFields'
import { describeApiError } from '@/i18n'
import { buildCreatePayload, EMPTY_LOCAL_FORM, type McpFormState } from '@/lib/mcp-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps/new',
  component: McpCreatePage,
})

function McpCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const create = useMutation({
    mutationFn: (payload: CreateMcp): Promise<Mcp> => api.post<Mcp>('/api/mcps', payload),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      navigate({ to: '/mcps/$name', params: { name: m.name } })
    },
  })

  // RFC-151 PR-1 — validation happens BEFORE mutate: buildCreatePayload
  // returns a discriminated union, and an invalid form only sets inline field
  // errors. The mutation never sees a sentinel error, so the form-actions
  // banner is reserved for real API failures.
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
        <h1>{t('mcps.newTitle')}</h1>
        <p className="page__hint">{t('mcps.newHint')}</p>
      </header>

      <McpFields value={form} onChange={setForm} errors={errors} />

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || form.name === ''}
          onClick={submit}
          data-testid="mcp-save-button"
        >
          {create.isPending ? t('common.creating') : t('mcps.createButton')}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeApiError(create.error)}</span>
        )}
      </div>
    </div>
  )
}
