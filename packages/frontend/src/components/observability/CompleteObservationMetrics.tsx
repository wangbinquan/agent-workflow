import { useTranslation } from 'react-i18next'
import type { CompleteObservationMetrics, CompleteObservationTrend } from '@agent-workflow/shared'
import { NoticeBanner } from '@/components/NoticeBanner'
import { OBSERVATION_TOKEN_BUCKETS, formatObservationCny } from './formatObservations'
import { observationGapLabel } from './observationGapLabel'

export function CompleteTokens({
  value,
  breakdown = true,
  recordedUsage,
  compact = false,
}: {
  value: CompleteObservationMetrics
  breakdown?: boolean
  recordedUsage?: CompleteObservationTrend['recordedUsage']
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  const recorded = value.state === 'not-ready' ? recordedUsage : undefined
  const tokens = value.state === 'ready' ? value.tokens : recorded?.tokens
  return (
    <>
      {recorded && !compact && (
        <span className="muted">{t('runObservability.recordedTokens')} · </span>
      )}
      <strong>
        {tokens
          ? BigInt(tokens.total).toLocaleString(i18n.language)
          : t(
              `runObservability.${value.state === 'not-applicable' ? 'notApplicable' : 'reportNotReady'}`,
            )}
      </strong>
      {breakdown && (
        <dl className="observation-token-buckets" data-token-buckets>
          {OBSERVATION_TOKEN_BUCKETS.map((bucket) => (
            <div key={bucket} data-token-bucket={bucket}>
              <dt>{t('runObservability.' + bucket)}</dt>
              <dd>
                {tokens
                  ? BigInt(tokens[bucket]).toLocaleString(i18n.language)
                  : t('runObservability.unknown')}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {recorded && compact && (
        <p className="muted">
          {t('runObservability.recordedUsageCompact', {
            observed: BigInt(recorded.observedInvocations).toLocaleString(i18n.language),
            calls: BigInt(recorded.invocations).toLocaleString(i18n.language),
          })}
        </p>
      )}
      {recorded && !compact && (
        <>
          <p className="muted">
            {t('runObservability.recordedUsageCoverage', {
              observed: BigInt(recorded.observedInvocations).toLocaleString(i18n.language),
              calls: BigInt(recorded.invocations).toLocaleString(i18n.language),
              records: BigInt(recorded.records).toLocaleString(i18n.language),
            })}
          </p>
          <p className="muted">{t('runObservability.recordedUsageWarning')}</p>
        </>
      )}
    </>
  )
}
export function CompleteCost({
  value,
  compact = false,
}: {
  value: CompleteObservationMetrics
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  const recorded = value.state === 'not-applicable' ? undefined : value.recordedCost
  if (recorded)
    return (
      <>
        <strong>{formatObservationCny(recorded.amount, true)}</strong>
        {compact ? (
          <p className="muted">
            {t('runObservability.recordedCostCoverage', {
              priced: BigInt(recorded.pricedRecords).toLocaleString(i18n.language),
              records: BigInt(recorded.records).toLocaleString(i18n.language),
            })}
          </p>
        ) : (
          <span className="muted"> · {t('runObservability.incompleteEstimate')}</span>
        )}
      </>
    )
  if (value.state === 'not-ready' && value.costCoverage)
    return (
      <span>
        {t(
          'runObservability.' +
            (value.costCoverage.visibility === 'hidden' ? 'hiddenCost' : 'unpriced'),
        )}
      </span>
    )
  if (value.state !== 'ready') return <span>{t('runObservability.unknown')}</span>
  return (
    <>
      <strong>{formatObservationCny(value.cost.amount, true)}</strong>
      {value.cost.state !== 'complete' && (
        <span className="muted">
          {' '}
          · {t('runObservability.' + (value.cost.state === 'hidden' ? 'hiddenCost' : 'unpriced'))}
        </span>
      )}
    </>
  )
}
export function CompleteMetrics({ value }: { value: CompleteObservationMetrics }) {
  const { t, i18n } = useTranslation()
  if (value.state === 'not-ready')
    return (
      <NoticeBanner tone="warning">
        {t('runObservability.reportNotReady')}
        <p>{value.gaps.map((reason) => observationGapLabel(reason, t)).join(' · ')}</p>
        <CompleteTokens value={value} />
        <p>
          {t('runObservability.cost')} · <CompleteCost value={value} />
        </p>
      </NoticeBanner>
    )
  if (value.state === 'not-applicable')
    return <p className="muted">{t('runObservability.notApplicable')}</p>
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.totalTokens')}</dt>
      <dd>
        <CompleteTokens value={value} />
      </dd>
      <dt>{t('runObservability.cost')}</dt>
      <dd>
        <CompleteCost value={value} />
      </dd>
      <dt>{t('runObservability.coverage')}</dt>
      <dd>
        {BigInt(value.observedInvocations).toLocaleString(i18n.language)} /{' '}
        {BigInt(value.invocations).toLocaleString(i18n.language)}
      </dd>
      <dt>{t('runObservability.numericRecords')}</dt>
      <dd>{BigInt(value.records).toLocaleString(i18n.language)}</dd>
    </dl>
  )
}
