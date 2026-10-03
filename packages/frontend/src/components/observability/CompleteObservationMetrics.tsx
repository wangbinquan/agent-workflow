import { useTranslation } from 'react-i18next'
import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import { NoticeBanner } from '@/components/NoticeBanner'
import { OBSERVATION_TOKEN_BUCKETS, formatObservationCny } from './formatObservations'

export function CompleteTokens({
  value,
  breakdown = true,
}: {
  value: CompleteObservationMetrics
  breakdown?: boolean
}) {
  const { t, i18n } = useTranslation()
  return (
    <>
      <strong>
        {value.state === 'ready'
          ? BigInt(value.tokens.total).toLocaleString(i18n.language)
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
                {value.state === 'ready'
                  ? BigInt(value.tokens[bucket]).toLocaleString(i18n.language)
                  : t('runObservability.unknown')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}
export function CompleteCost({ value }: { value: CompleteObservationMetrics }) {
  const { t } = useTranslation()
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
        <p>{value.gaps.join(' · ')}</p>
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
