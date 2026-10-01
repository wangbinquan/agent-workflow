import type { ReactNode, RefObject } from 'react'
import { observationModelKey, type ObservationOverview } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Metrics } from './ObservationMetrics'

export function ObservationDimensionDetails({
  open,
  row,
  partial,
  onClose,
  onSelect,
  triggerRef,
  fallbackRef,
  children,
}: {
  readonly open: boolean
  readonly row: ObservationOverview['models'][number] | undefined
  readonly partial: boolean
  readonly onClose: () => void
  readonly onSelect: () => void
  readonly triggerRef: RefObject<HTMLElement | null>
  readonly fallbackRef: RefObject<HTMLElement | null>
  readonly children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('runObservability.modelContributions', {
        name: row?.model ?? t('runObservability.modelUnknown'),
      })}
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
        data-observation-contributions={`model:${row ? observationModelKey(row) : 'missing'}`}
      >
        {row === undefined ? (
          <EmptyState title={t('runObservability.dimensionMissing')} size="compact" />
        ) : (
          <>
            <NoticeBanner tone="info" size="compact">
              {t('runObservability.dimensionContributionHint')}
            </NoticeBanner>
            {(partial || row.metrics.truncated) && (
              <NoticeBanner tone="warning" size="compact">
                {t('runObservability.limitHint')}
              </NoticeBanner>
            )}
            <Card title={t('runObservability.model')}>
              <Metrics value={row.metrics} />
              <button type="button" className="btn btn--sm" onClick={onSelect}>
                {t('runObservability.relatedTasks')}
              </button>
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
