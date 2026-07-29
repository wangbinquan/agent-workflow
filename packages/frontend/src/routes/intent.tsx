// RFC-235 — goal-first Intent landing page. The inline composer is the primary
// action; resource shortcuts open the same business form in a URL-owned dialog.

import type { IntentSessionSummary } from '@agent-workflow/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { IntentCreateComposer } from '@/components/intent/IntentCreateComposer'
import { IntentSessionList } from '@/components/intent/IntentSessionList'
import { PageHeader } from '@/components/PageHeader'
import { INTENT_QUERY_KEYS, useIntentSessionsWs } from '@/hooks/useIntentSessionsWs'
import { Route as RootRoute } from './__root'

type IntentArtifactHint = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'

export interface IntentSearch {
  create?: boolean
  hint?: IntentArtifactHint
  mountType?: IntentArtifactHint
  mountId?: string
}

const ARTIFACT_TYPES = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const

function artifactType(value: unknown): IntentArtifactHint | undefined {
  return ARTIFACT_TYPES.find((type) => type === value)
}

function validateIntentSearch(search: Record<string, unknown>): IntentSearch {
  const hint = artifactType(search.hint)
  const mountType = artifactType(search.mountType)
  return {
    ...(search.create === true || search.create === 'true' ? { create: true } : {}),
    ...(hint === undefined ? {} : { hint }),
    ...(mountType === undefined ? {} : { mountType }),
    ...(typeof search.mountId === 'string' && search.mountId !== ''
      ? { mountId: search.mountId }
      : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/intent',
  component: IntentSessionsPage,
  validateSearch: validateIntentSearch,
})

function IntentSessionsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const search = Route.useSearch()
  const [dialogFooterTarget, setDialogFooterTarget] = useState<HTMLDivElement | null>(null)
  useIntentSessionsWs()

  const sessions = useQuery<IntentSessionSummary[], ApiError>({
    queryKey: INTENT_QUERY_KEYS.list,
    queryFn: () => api.get<IntentSessionSummary[]>('/api/intent-sessions'),
  })
  const openSession = async (session: IntentSessionSummary): Promise<void> => {
    await qc.invalidateQueries({ queryKey: INTENT_QUERY_KEYS.list })
    void navigate({ to: '/intent/$sessionId', params: { sessionId: session.id } })
  }
  const closeDialog = (): void => {
    void navigate({ to: '/intent', search: {}, replace: true })
  }
  const dialogMount =
    search.mountType !== undefined && search.mountId !== undefined
      ? { resourceType: search.mountType, resourceId: search.mountId }
      : undefined

  return (
    <div className="page intent-page">
      <PageHeader title={t('intent.title')} meta={t('intent.createLead')} />

      <section className="intent-page__hero" aria-label={t('intent.messageLabel')}>
        <IntentCreateComposer variant="inline" onCreated={openSession} />
      </section>

      <IntentSessionList
        sessions={sessions.data}
        loading={sessions.isLoading}
        error={sessions.isError ? sessions.error : null}
      />

      <Dialog
        open={search.create === true}
        onClose={closeDialog}
        title={dialogMount === undefined ? t('intent.newSession') : t('intent.entryModify')}
        size="lg"
        footer={
          <div
            ref={setDialogFooterTarget}
            className="intent-create-dialog__footer-target"
            data-testid="intent-create-dialog-footer"
          />
        }
      >
        <IntentCreateComposer
          key={`${search.hint ?? 'auto'}:${search.mountType ?? ''}:${search.mountId ?? ''}`}
          variant="dialog"
          initialHint={search.hint ?? 'auto'}
          {...(dialogMount === undefined ? {} : { mount: dialogMount })}
          onCancel={closeDialog}
          onCreated={openSession}
          footerTarget={dialogFooterTarget}
        />
      </Dialog>
    </div>
  )
}
