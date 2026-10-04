import type { ReactNode, RefObject } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { CompleteObservationDimension } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { NoticeBanner } from '@/components/NoticeBanner'
import { CompleteMetrics } from './CompleteObservationMetrics'

export function completeDimensionName(row: CompleteObservationDimension, t: TFunction): string {
  if (row.kind === 'purpose') return t('runObservability.purpose_' + row.label)
  if (row.kind === 'source') return t('runObservability.' + row.label)
  return (
    row.label ??
    t(
      'runObservability.' +
        (row.kind === 'runtime'
          ? 'runtimeNameUnknown'
          : row.kind === 'model'
            ? 'modelUnknown'
            : 'unknown'),
    )
  )
}

/** The sealed dimension contribution and the full Task remain distinct exact metrics. */
export function CompleteDimensionDetails({
  row,
  onClose,
  onRelatedTasks,
  triggerRef,
  fallbackRef,
  children,
}: {
  row: CompleteObservationDimension
  onClose: () => void
  onRelatedTasks?: () => void
  triggerRef: RefObject<HTMLElement | null>
  fallbackRef: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const { t } = useTranslation(),
    name = completeDimensionName(row, t)
  const runtime = row.selection.runtime
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      triggerRef={triggerRef}
      restoreFocusFallbackRef={fallbackRef}
      title={
        row.kind === 'runtime'
          ? t('runObservability.runtimeContributions', { name })
          : row.kind === 'model'
            ? t('runObservability.modelContributions', { name })
            : name
      }
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div
        className="stack--md"
        data-observation-contributions={row.key}
        data-observation-runtime-contributions={row.kind === 'runtime' ? true : undefined}
      >
        <NoticeBanner tone="info" size="compact">
          {t(
            'runObservability.' +
              (row.kind === 'runtime'
                ? 'runtimeContributionHint'
                : row.kind === 'model'
                  ? 'dimensionContributionHint'
                  : 'dimensionTimeHint'),
          )}
        </NoticeBanner>
        <Card
          title={t(
            'runObservability.' +
              (row.kind === 'runtime'
                ? 'runtimeSummary'
                : row.kind === 'model'
                  ? 'model'
                  : 'contributions'),
          )}
        >
          <CompleteMetrics value={row.metrics} />
          {runtime && (
            <dl className="detail-grid observation-metrics">
              {runtime.authority === 'local' ? (
                <>
                  <dt>{t('runObservability.runtimeRegistration')}</dt>
                  <dd>{runtime.registrationId ?? t('runObservability.registrationUnknown')}</dd>
                  <dt>{t('runObservability.runtimeConfiguration')}</dt>
                  <dd>{runtime.configurationRevision ?? '—'}</dd>
                  <dt>{t('runObservability.runtimeProtocol')}</dt>
                  <dd>{runtime.protocol ?? '—'}</dd>
                </>
              ) : (
                <>
                  <dt>{t('runObservability.runtimeSource')}</dt>
                  <dd>{runtime.sourceId ?? '—'}</dd>
                </>
              )}
            </dl>
          )}
          {row.selection.model && (
            <dl className="detail-grid observation-metrics">
              <dt>{t('runObservability.actualModel')}</dt>
              <dd>
                {name}
                {row.selection.model.provider && (
                  <div className="muted">{row.selection.model.provider}</div>
                )}
              </dd>
            </dl>
          )}
          {row.selection.agent?.revision != null && (
            <p className="muted">
              {t('runObservability.revision', { revision: row.selection.agent.revision })}
            </p>
          )}
          {onRelatedTasks && (
            <button type="button" className="btn btn--sm" onClick={onRelatedTasks}>
              {t('runObservability.relatedTasks')}
            </button>
          )}
        </Card>
        <Card title={t('runObservability.taskContributions')}>{children}</Card>
      </div>
    </Dialog>
  )
}
