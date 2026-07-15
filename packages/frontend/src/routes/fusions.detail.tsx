// RFC-101 — fusion detail + approval gate. Shows the proposed before/after
// diff (DiffViewer) once the engine task settles; the merger approves (apply),
// rejects-with-feedback (re-run), or cancels. While running, points the merger
// at the clarify inbox (mandatory ask-back happens there).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Fusion, Memory } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { DiffViewer } from '@/components/DiffViewer'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import { MemoryReviewItem } from '@/components/fusion/MemoryReviewItem'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/fusions/$id',
  component: FusionDetailPage,
})

const ACTIVE = new Set(['running', 'applying'])

function FusionDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [feedback, setFeedback] = useState('')

  const fusion = useQuery<Fusion>({
    queryKey: ['fusions', id],
    queryFn: ({ signal }) => api.get(`/api/fusions/${encodeURIComponent(id)}`, undefined, signal),
    // Poll while the engine task is still working so awaiting_approval lands
    // without a manual refresh.
    refetchInterval: (q) =>
      ACTIVE.has((q.state.data as Fusion | undefined)?.status ?? '') ? 2000 : false,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fusions', id] })

  // Fetch the involved memories' title/scope/body so the reviewer can judge
  // what was incorporated/skipped — a bare id list is unreviewable.
  const memoryIds = fusion.data?.memoryIds ?? []
  const memDetails = useQuery<Record<string, Memory | null>>({
    queryKey: ['fusions', id, 'memory-details', memoryIds.join(',')],
    enabled: memoryIds.length > 0,
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        memoryIds.map((mid) =>
          api
            .get<{ memory: Memory }>(`/api/memories/${encodeURIComponent(mid)}`, undefined, signal)
            .then((r) => [mid, r.memory] as const)
            .catch(() => [mid, null] as const),
        ),
      )
      return Object.fromEntries(entries)
    },
  })

  const approve = useMutation<Fusion, ApiError>({
    mutationFn: () => api.post(`/api/fusions/${encodeURIComponent(id)}/approve`),
    onSuccess: () => {
      invalidate()
      void qc.invalidateQueries({ queryKey: ['skills'] })
      void qc.invalidateQueries({ queryKey: ['memories'] })
    },
  })
  const reject = useMutation<Fusion, ApiError>({
    mutationFn: () => api.post(`/api/fusions/${encodeURIComponent(id)}/reject`, { feedback }),
    onSuccess: () => {
      setRejectOpen(false)
      setFeedback('')
      invalidate()
    },
  })
  const cancel = useMutation<Fusion, ApiError>({
    mutationFn: () => api.post(`/api/fusions/${encodeURIComponent(id)}/cancel`),
    onSuccess: invalidate,
  })

  if (fusion.data === undefined && fusion.isLoading) {
    return (
      <div className="page">
        <PageHeader title={t('fusion.detailTitle')} />
        <LoadingState />
      </div>
    )
  }
  if (fusion.data === undefined && fusion.error) {
    return (
      <div className="page">
        <PageHeader title={t('fusion.detailTitle')} />
        <ErrorBanner
          error={fusion.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void fusion.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      </div>
    )
  }
  const f = fusion.data
  if (f === undefined) return null

  const isAwaiting = f.status === 'awaiting_approval'
  const isActive = ACTIVE.has(f.status)

  return (
    <div className="page page--wide">
      <PageHeader
        title={t('fusion.detailTitle')}
        meta={
          <>
            <Link to="/skills/$name" params={{ name: f.skillName }}>
              {f.skillName}
            </Link>{' '}
            <span className={`chip chip--tight chip--fusion-${f.status}`}>
              {t(`fusion.status.${f.status}`)}
            </span>{' '}
            <span className="muted">{t('fusion.iteration', { n: f.iteration })}</span>
          </>
        }
        actions={
          !['done', 'failed', 'canceled'].includes(f.status) ? (
            <ConfirmButton
              label={t('fusion.cancel')}
              confirmLabel={t('fusion.cancelConfirm')}
              onConfirm={() => cancel.mutateAsync()}
              variant="danger"
              disabled={cancel.isPending}
            />
          ) : undefined
        }
      />

      {fusion.error ? (
        <ErrorBanner
          error={fusion.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void fusion.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      ) : null}
      {approve.error ? <ErrorBanner error={approve.error} /> : null}
      {cancel.error ? <ErrorBanner error={cancel.error} /> : null}

      {isActive && (
        <NoticeBanner
          tone="info"
          action={
            f.currentTaskId !== null ? (
              <Link className="btn btn--sm" to="/clarify">
                {t('fusion.clarifyLink')}
              </Link>
            ) : undefined
          }
        >
          {t('fusion.runningHint')}
        </NoticeBanner>
      )}

      {f.status === 'failed' && f.error !== null && (
        <section className="page__section">
          <h2>{t('fusion.errorHeading')}</h2>
          <pre className="readonly-pre">{f.error}</pre>
        </section>
      )}

      {f.status === 'done' && f.appliedSkillVersion !== null && (
        <section className="page__section">
          <p>{t('fusion.appliedVersion', { n: f.appliedSkillVersion })}</p>
        </section>
      )}

      {(isAwaiting || f.status === 'done') && f.changelog !== null && (
        <section className="page__section">
          <h2>{t('fusion.changelogHeading')}</h2>
          <pre className="readonly-pre">{f.changelog}</pre>
        </section>
      )}

      {(isAwaiting || f.status === 'done') && (
        <section className="page__section">
          <h2>{t('fusion.incorporatedHeading', { n: f.incorporatedMemoryIds?.length ?? 0 })}</h2>
          <ul className="fusion-mem-list">
            {(f.incorporatedMemoryIds ?? []).map((mid) => (
              <MemoryReviewItem
                key={mid}
                id={mid}
                mem={memDetails.data?.[mid] ?? null}
                loading={memDetails.isLoading}
              />
            ))}
          </ul>
          {(f.skipped?.length ?? 0) > 0 && (
            <>
              <h2>{t('fusion.skippedHeading', { n: f.skipped?.length ?? 0 })}</h2>
              <ul className="fusion-mem-list">
                {(f.skipped ?? []).map((s) => (
                  <MemoryReviewItem
                    key={s.memoryId}
                    id={s.memoryId}
                    mem={memDetails.data?.[s.memoryId] ?? null}
                    loading={memDetails.isLoading}
                    reason={s.reason}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {isAwaiting && (
        <section className="page__section">
          <h2>{t('fusion.proposedHeading')}</h2>
          <DiffViewer diff={f.proposedDiff ?? ''} />
          <div className="page__actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
            >
              {approve.isPending ? t('fusion.approving') : t('fusion.approve')}
            </button>
            <button type="button" className="btn" onClick={() => setRejectOpen(true)}>
              {t('fusion.reject')}
            </button>
          </div>
        </section>
      )}

      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={t('fusion.rejectTitle')}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRejectOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => reject.mutate()}
              disabled={reject.isPending || feedback.trim() === ''}
            >
              {t('fusion.rejectSubmit')}
            </button>
          </>
        }
      >
        {reject.error ? <ErrorBanner error={reject.error} /> : null}
        <Field label={t('fusion.rejectTitle')}>
          <TextArea
            value={feedback}
            onChange={setFeedback}
            rows={4}
            placeholder={t('fusion.rejectFeedbackPlaceholder')}
          />
        </Field>
      </Dialog>
    </div>
  )
}
