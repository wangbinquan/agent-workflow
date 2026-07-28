// RFC-234 (T8) — intent-builder session list: history + "describe your goal"
// entry. Creation opens a Dialog (message + optional hint), POSTs the session
// (the first generation turn fires server-side) and navigates to the detail.

import type { IntentSessionSummary } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { INTENT_QUERY_KEYS, useIntentSessionsWs } from '@/hooks/useIntentSessionsWs'
import { shouldRowNavigate } from '@/lib/row-nav'
import { Route as RootRoute } from './__root'

export interface IntentSearch {
  create?: boolean
  hint?: string
  mountType?: 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'
  mountId?: string
}

function validateIntentSearch(search: Record<string, unknown>): IntentSearch {
  const types = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const
  const mountType = types.find((t) => t === search.mountType)
  return {
    ...(search.create === true || search.create === 'true' ? { create: true } : {}),
    ...(typeof search.hint === 'string' && search.hint !== '' ? { hint: search.hint } : {}),
    ...(mountType !== undefined ? { mountType } : {}),
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
  useIntentSessionsWs()
  // Entry points (resource pages / editors) land here with ?create=1 and an
  // optional hint / mount target — the dialog opens pre-filled and the created
  // session mounts the target before navigating to it (RFC-234 T11).
  const [createOpen, setCreateOpen] = useState(search.create === true)
  const [message, setMessage] = useState('')
  const [hint, setHint] = useState(search.hint ?? '')

  const sessions = useQuery<IntentSessionSummary[], ApiError>({
    queryKey: INTENT_QUERY_KEYS.list,
    queryFn: () => api.get<IntentSessionSummary[]>('/api/intent-sessions'),
  })

  const createSession = useMutation<IntentSessionSummary, ApiError, void>({
    mutationFn: () =>
      api.post<IntentSessionSummary>('/api/intent-sessions', {
        message: message.trim(),
        ...(hint.trim() === '' ? {} : { hint: hint.trim() }),
        // Modify-entry prefill rides the CREATE so the mount lands before the
        // auto-fired first turn (a post-create mount would 409 against it).
        ...(search.mountType !== undefined && search.mountId !== undefined
          ? { mounts: [{ resourceType: search.mountType, resourceId: search.mountId }] }
          : {}),
      }),
    onSuccess: async (session) => {
      setCreateOpen(false)
      setMessage('')
      setHint('')
      await qc.invalidateQueries({ queryKey: INTENT_QUERY_KEYS.list })
      void navigate({ to: '/intent/$sessionId', params: { sessionId: session.id } })
    },
  })

  return (
    <div className="page">
      <PageHeader
        title={t('intent.title')}
        meta={t('intent.description')}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setCreateOpen(true)}>
            {t('intent.newSession')}
          </button>
        }
      />
      {sessions.isLoading ? <LoadingState /> : null}
      {sessions.isError ? <ErrorBanner error={sessions.error} /> : null}
      {sessions.data !== undefined && sessions.data.length === 0 ? (
        <EmptyState
          title={t('intent.emptyTitle')}
          description={t('intent.emptyDescription')}
          action={
            <button type="button" className="btn btn--primary" onClick={() => setCreateOpen(true)}>
              {t('intent.newSession')}
            </button>
          }
        />
      ) : null}
      {sessions.data !== undefined && sessions.data.length > 0 ? (
        <TableViewport label={t('intent.title')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('intent.columnTitle')}</th>
                <th>{t('intent.columnStatus')}</th>
                <th>{t('intent.columnRounds')}</th>
                <th>{t('intent.columnCommits')}</th>
                <th>{t('intent.columnUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((session) => (
                <tr
                  key={session.id}
                  className="table__row table__row--clickable"
                  onClick={(event) => {
                    if (!shouldRowNavigate(event)) return
                    void navigate({ to: '/intent/$sessionId', params: { sessionId: session.id } })
                  }}
                >
                  <td>{session.title}</td>
                  <td>
                    {session.inFlight ? (
                      <StatusChip kind="info">{t('intent.statusRunning')}</StatusChip>
                    ) : session.status === 'archived' ? (
                      <StatusChip kind="neutral">{t('intent.statusArchived')}</StatusChip>
                    ) : (
                      <StatusChip kind="success">{t('intent.statusActive')}</StatusChip>
                    )}
                  </td>
                  <td>{session.turnSeq}</td>
                  <td>{session.commitSeq}</td>
                  <td>
                    <RelativeTime ts={session.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : null}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('intent.newSession')}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={message.trim() === '' || createSession.isPending}
              onClick={() => createSession.mutate()}
            >
              {t('intent.startBuilding')}
            </button>
          </>
        }
      >
        {createSession.isError ? <ErrorBanner error={createSession.error} /> : null}
        <Field label={t('intent.messageLabel')} hint={t('intent.messageHint')} required>
          <TextArea
            value={message}
            onChange={setMessage}
            rows={6}
            placeholder={t('intent.messagePlaceholder')}
            data-testid="intent-create-message"
          />
        </Field>
        {search.mountType !== undefined && search.mountId !== undefined ? (
          // Modify entry: the target is the mounted resource itself — asking
          // for an artifact type here would be nonsense (user feedback,
          // 2026-07-28). Show what will be modified instead.
          <p className="muted" data-testid="intent-modify-target">
            {t('intent.modifyTargetNote', {
              type: t(`intent.resourceType.${search.mountType}`),
            })}
          </p>
        ) : (
          <Field label={t('intent.hintLabel')} hint={t('intent.hintHint')}>
            <Select<'auto' | 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'>
              value={
                hint === '' ||
                !['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'].includes(hint)
                  ? 'auto'
                  : (hint as 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup')
              }
              ariaLabel={t('intent.hintLabel')}
              onChange={(value) => setHint(value === 'auto' ? '' : value)}
              options={[
                { value: 'auto', label: t('intent.hintAuto') },
                ...(['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const).map(
                  (value) => ({ value, label: t(`intent.resourceType.${value}`) }),
                ),
              ]}
            />
          </Field>
        )}
      </Dialog>
    </div>
  )
}
