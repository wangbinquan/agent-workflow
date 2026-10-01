import type { ReactNode, RefObject } from 'react'
import type { ObservationRuntimeSummary } from '@agent-workflow/shared'
import { observationRuntimeKey } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Metrics } from './ObservationMetrics'

export function ObservationRuntimeDetails({
  open,
  row,
  title,
  partial,
  onClose,
  triggerRef,
  fallbackRef,
  children,
  onSelect,
}: {
  open: boolean
  row: ObservationRuntimeSummary | undefined
  title: string
  partial: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
  fallbackRef: RefObject<HTMLElement | null>
  children: ReactNode
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('runObservability.runtimeContributions', { name: title })}
      size="lg"
      triggerRef={triggerRef}
      restoreFocusFallbackRef={fallbackRef}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div
        className="stack--md"
        data-observation-runtime-contributions
        data-observation-contributions={`runtime:${row ? observationRuntimeKey(row) : 'missing'}`}
      >
        {row === undefined ? (
          <EmptyState title={t('runObservability.runtimeNotInSample')} size="compact" />
        ) : (
          <>
            <NoticeBanner tone="info" size="compact">
              {t('runObservability.runtimeContributionHint')}
            </NoticeBanner>
            {(partial || row.metrics.truncated) && (
              <NoticeBanner tone="warning" size="compact">
                {t('runObservability.limitHint')}
              </NoticeBanner>
            )}
            <Card title={t('runObservability.runtimeSummary')}>
              {onSelect && (
                <button type="button" className="btn btn--sm" onClick={onSelect}>
                  {t('runObservability.relatedTasks')}
                </button>
              )}
              <Metrics value={row.metrics} />
              <dl className="detail-grid observation-metrics">
                {row.authority === 'local' ? (
                  <>
                    <dt>{t('runObservability.runtimeRegistration')}</dt>
                    <dd>{row.registrationId ?? t('runObservability.registrationUnknown')}</dd>
                    <dt>{t('runObservability.runtimeConfiguration')}</dt>
                    <dd>{row.configurationRevision === null ? '—' : row.configurationRevision}</dd>
                    <dt>{t('runObservability.runtimeProtocol')}</dt>
                    <dd>{row.protocol ?? '—'}</dd>
                  </>
                ) : (
                  <>
                    <dt>{t('runObservability.runtimeSource')}</dt>
                    <dd>{row.sourceId ?? '—'}</dd>
                  </>
                )}
              </dl>
              {(row.unnamedInvocations ?? 0) > 0 && (
                <p className="muted">
                  {t('runObservability.runtimeUnnamedCalls', { count: row.unnamedInvocations })}
                </p>
              )}
            </Card>
            {row.tasks === undefined ? (
              <NoticeBanner tone="warning" size="compact">
                {t('runObservability.runtimeContributionsUnavailable')}
              </NoticeBanner>
            ) : (
              <Card title={t('runObservability.taskContributions')}>{children}</Card>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
