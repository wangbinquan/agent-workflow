// RFC-043 — admin-only distill job detail page. Reachable from the
// Distill Jobs tab inside /memory (row → click); non-admin actors land
// on a placeholder identical in tone to the existing "Admin only" tab.
//
// The page composes 6 independent sections:
//   - DetailHeader          status + meta
//   - FailureDiagnostics    (conditional)
//   - SourceEventsList      what was distilled
//   - ScopeAndDedupSnapshot what the distiller saw
//   - CandidatesList        what came out
//   - ConversationSection   reuses RFC-027 ConversationFlow
//
// Detail + session data are two independent queries. A failure in the
// session query never blanks the detail page — admin can still see the
// other 5 sections + a localized error inside ConversationSection.

import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemoryDistillJobDetail, MemoryDistillSessionView } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { DetailLayout } from '@/components/DetailLayout'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { useActor, useIsAdmin } from '@/hooks/useActor'
import { useMemoryDistillJobWs } from '@/hooks/useMemoryDistillJobWs'
import { describeApiError } from '@/i18n'
import { Route as RootRoute } from './__root'
import { CandidatesList } from '@/components/memory/distill-job-detail/CandidatesList'
import { ConversationSection } from '@/components/memory/distill-job-detail/ConversationSection'
import { DetailHeader } from '@/components/memory/distill-job-detail/DetailHeader'
import { FailureDiagnostics } from '@/components/memory/distill-job-detail/FailureDiagnostics'
import { ScopeAndDedupSnapshot } from '@/components/memory/distill-job-detail/ScopeAndDedupSnapshot'
import { SourceEventsList } from '@/components/memory/distill-job-detail/SourceEventsList'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/memory/distill-jobs/$jobId',
  component: DistillJobDetailPage,
})

function DistillJobDetailPage() {
  const { t } = useTranslation()
  const actor = useActor()
  const isAdmin = useIsAdmin()
  const { jobId } = Route.useParams()

  // Keep WS subscription mounted so detail page invalidates when the
  // scheduler updates the job (e.g. retry succeeds while admin is on
  // the page).
  useMemoryDistillJobWs({ enabled: isAdmin })

  const detailQ = useQuery<MemoryDistillJobDetail, ApiError>({
    queryKey: ['memory-distill-jobs', 'detail', jobId],
    queryFn: ({ signal }) =>
      api.get(`/api/memory-distill-jobs/${encodeURIComponent(jobId)}`, undefined, signal),
    enabled: isAdmin,
  })

  const sessionQ = useQuery<MemoryDistillSessionView, ApiError>({
    queryKey: ['memory-distill-jobs', 'session', jobId],
    queryFn: ({ signal }) =>
      api.get(`/api/memory-distill-jobs/${encodeURIComponent(jobId)}/session`, undefined, signal),
    enabled: isAdmin,
  })

  if (actor.isLoading) {
    return (
      <div className="page page--memory page--distill-job-detail">
        <PageHeader title={jobId} />
        <LoadingState />
      </div>
    )
  }

  if (actor.error !== null && actor.error !== undefined) {
    return (
      <div className="page page--memory page--distill-job-detail">
        <PageHeader title={jobId} />
        <ErrorBanner error={actor.error} onRetry={() => void actor.refetch()} />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="page page--memory page--distill-job-detail">
        <PageHeader title={jobId} />
        <EmptyState
          title={t('memory.distillJobDetail.adminOnly')}
          data-testid="distill-detail-admin-only"
        />
      </div>
    )
  }

  const detail = detailQ.data
  if (detail === undefined) {
    if (detailQ.isLoading) {
      return (
        <div className="page page--memory page--distill-job-detail">
          <PageHeader title={jobId} />
          <LoadingState />
        </div>
      )
    }
    if (detailQ.error !== null && detailQ.error !== undefined) {
      return (
        <div className="page page--memory page--distill-job-detail">
          <PageHeader title={jobId} />
          <ErrorBanner
            error={detailQ.error}
            message={`${t('memory.distillJobDetail.loadError')}: ${describeApiError(detailQ.error)}`}
            onRetry={() => void detailQ.refetch()}
          />
        </div>
      )
    }
    return null
  }

  return (
    <div className="page page--memory page--distill-job-detail">
      <DetailLayout
        main={
          <div className="distill-job-detail">
            <DetailHeader job={detail.job} />
            {detailQ.error !== null && detailQ.error !== undefined && (
              <ErrorBanner
                error={detailQ.error}
                message={`${t('memory.distillJobDetail.loadError')}: ${describeApiError(detailQ.error)}`}
                onRetry={() => void detailQ.refetch()}
              />
            )}
            <FailureDiagnostics job={detail.job} />
            <section
              className="distill-job-detail__section"
              data-testid="distill-source-events-section"
            >
              <h2 className="distill-job-detail__section-title">
                {t('memory.distillJobDetail.section.sourceEvents')}
              </h2>
              <SourceEventsList items={detail.sourceEvents} />
            </section>
            <section className="distill-job-detail__section" data-testid="distill-scope-section">
              <h2 className="distill-job-detail__section-title">
                {t('memory.distillJobDetail.section.scope')}
              </h2>
              <ScopeAndDedupSnapshot
                scope={detail.job.scopeResolved}
                snapshot={detail.dedupSnapshot}
              />
            </section>
            <section
              className="distill-job-detail__section"
              data-testid="distill-candidates-section"
            >
              <h2 className="distill-job-detail__section-title">
                {t('memory.distillJobDetail.section.candidates')}
              </h2>
              <CandidatesList items={detail.candidates} />
            </section>
            <section
              className="distill-job-detail__section"
              data-testid="distill-conversation-section"
            >
              <h2 className="distill-job-detail__section-title">
                {t('memory.distillJobDetail.section.conversation')}
              </h2>
              <ConversationSection
                sessionData={sessionQ.data}
                loading={sessionQ.isLoading}
                error={
                  sessionQ.error !== null && sessionQ.error !== undefined ? (
                    <div data-testid="distill-session-load-error">
                      <ErrorBanner
                        error={sessionQ.error}
                        message={`${t('memory.distillJobDetail.sessionLoadError')}: ${describeApiError(sessionQ.error)}`}
                        onRetry={() => void sessionQ.refetch()}
                      />
                    </div>
                  ) : null
                }
              />
            </section>
          </div>
        }
      />
    </div>
  )
}
