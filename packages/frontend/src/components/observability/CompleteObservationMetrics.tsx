import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompleteObservationMetrics, CompleteObservationTrend } from '@agent-workflow/shared'
import { OBSERVATION_TOKEN_BUCKETS, formatObservationCny } from './formatObservations'
import { observationGapLabel } from './observationGapLabel'
import { FormSection } from '@/components/FormSection'

export function CompleteTokens({
  value,
  breakdown = true,
  recordedUsage,
  compact = false,
}: {
  value: CompleteObservationMetrics
  breakdown?: boolean
  recordedUsage?:
    | CompleteObservationTrend['recordedUsage']
    | Extract<CompleteObservationMetrics, { state: 'not-ready' }>['recordedUsage']
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  const recorded = value.state === 'not-ready' ? (value.recordedUsage ?? recordedUsage) : undefined
  const tokens = value.state === 'ready' ? value.tokens : recorded?.tokens
  const bucketValues = OBSERVATION_TOKEN_BUCKETS.map((bucket) => ({
    bucket,
    text:
      tokens && tokens[bucket] !== null
        ? BigInt(tokens[bucket]).toLocaleString(i18n.language)
        : t('runObservability.unknown'),
  }))
  const bucketCoverage =
    recorded && 'bucketRecords' in recorded && recorded.records !== '0' ? recorded : null
  const allBucketRecords =
    bucketCoverage &&
    OBSERVATION_TOKEN_BUCKETS.every(
      (bucket) => bucketCoverage.bucketRecords[bucket] === bucketCoverage.records,
    )
  const historicalReferences =
    recorded && 'historicalReferences' in recorded ? recorded.historicalReferences : undefined
  const observedHistoricalReferences =
    recorded && 'observedHistoricalReferences' in recorded
      ? recorded.observedHistoricalReferences
      : undefined
  const historical =
    historicalReferences !== undefined && BigInt(historicalReferences) > 0n
      ? t('runObservability.historicalObservedCoverage', {
          observed:
            observedHistoricalReferences === undefined
              ? t('runObservability.unknown')
              : BigInt(observedHistoricalReferences).toLocaleString(i18n.language),
          references: BigInt(historicalReferences).toLocaleString(i18n.language),
        })
      : null
  return (
    <>
      <strong>
        {tokens
          ? BigInt(tokens.total).toLocaleString(i18n.language)
          : t(`runObservability.${value.state === 'not-applicable' ? 'notApplicable' : 'unknown'}`)}
      </strong>
      {value.state === 'not-ready' && (
        <FormSection
          title={t('runObservability.usageIncomplete')}
          collapsible
          size="compact"
          className="observation-metric-notes"
        >
          {recorded && (
            <p className="muted">
              {recorded.invocations === '0'
                ? `${t('runObservability.numericRecords')} · ${BigInt(recorded.records).toLocaleString(i18n.language)}`
                : t(
                    compact
                      ? 'runObservability.recordedUsageCompact'
                      : 'runObservability.recordedUsageCoverage',
                    {
                      observed: BigInt(recorded.observedInvocations).toLocaleString(i18n.language),
                      calls: BigInt(recorded.invocations).toLocaleString(i18n.language),
                      records: BigInt(recorded.records).toLocaleString(i18n.language),
                    },
                  )}
            </p>
          )}
          {historical && <p className="muted">{historical}</p>}
          <p className="muted">
            {value.gaps.length
              ? value.gaps.map((reason) => observationGapLabel(reason, t)).join(' · ')
              : t('runObservability.reportNotReady')}
          </p>
          {bucketCoverage && (
            <div
              className="observation-token-coverage"
              role="group"
              aria-label={t('runObservability.bucketCoverage')}
            >
              {allBucketRecords ? (
                <p>
                  {t('runObservability.bucketCoverageComplete', {
                    records: BigInt(bucketCoverage.records).toLocaleString(i18n.language),
                  })}
                </p>
              ) : (
                <>
                  <span>{t('runObservability.bucketCoverage')}</span>
                  <dl>
                    {OBSERVATION_TOKEN_BUCKETS.map((bucket) => (
                      <div key={bucket} data-token-coverage={bucket}>
                        <dt>{t('runObservability.' + bucket)}</dt>
                        <dd>
                          {BigInt(bucketCoverage.bucketRecords[bucket]).toLocaleString(
                            i18n.language,
                          )}
                          {' / '}
                          {BigInt(bucketCoverage.records).toLocaleString(i18n.language)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          )}
        </FormSection>
      )}
      {breakdown && (
        <>
          <dl
            className={`observation-token-buckets${compact ? ' observation-token-buckets--summary' : ''}`}
            data-token-buckets
            style={
              compact
                ? ({
                    '--observation-token-value-width': `${Math.max(...bucketValues.map((row) => row.text.length))}ch`,
                  } as CSSProperties)
                : undefined
            }
          >
            {bucketValues.map(({ bucket, text }) => (
              <div key={bucket} data-token-bucket={bucket}>
                <dt>{t('runObservability.' + bucket)}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </>
  )
}
export function CompleteCost({ value }: { value: CompleteObservationMetrics; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const recorded = value.state === 'not-applicable' ? undefined : value.recordedCost
  const onlyZeroCost =
    recorded &&
    BigInt(recorded.pricedRecords) + BigInt(recorded.partiallyPricedRecords ?? '0') === 0n &&
    BigInt(recorded.knownZeroCostInvocations ?? '0') > 0n
  if (recorded)
    return (
      <>
        <strong>{formatObservationCny(recorded.amount, true)}</strong>
        <FormSection
          title={t('runObservability.incompleteEstimate')}
          collapsible
          size="compact"
          className="observation-metric-notes"
        >
          {onlyZeroCost ? (
            <p className="muted">
              {t('runObservability.recordedZeroCostCoverage', {
                calls: BigInt(recorded.knownZeroCostInvocations!).toLocaleString(i18n.language),
              })}
            </p>
          ) : (
            <p className="muted">
              {t(
                BigInt(recorded.partiallyPricedRecords ?? '0') > 0n
                  ? 'runObservability.recordedPartialCostCoverage'
                  : 'runObservability.recordedCostCoverage',
                {
                  priced: BigInt(recorded.pricedRecords).toLocaleString(i18n.language),
                  partial: BigInt(recorded.partiallyPricedRecords ?? '0').toLocaleString(
                    i18n.language,
                  ),
                  records: BigInt(recorded.records).toLocaleString(i18n.language),
                },
              )}
            </p>
          )}
        </FormSection>
      </>
    )
  if (value.state === 'not-ready' && value.costCoverage)
    return (
      <span>
        {t(
          'runObservability.' +
            (value.costCoverage.visibility === 'hidden'
              ? 'hiddenCost'
              : BigInt(value.tokenCoverage?.historicalReferences ?? '0') > 0n
                ? 'historicalPriceMissing'
                : 'unpriced'),
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
  if (value.state === 'not-applicable')
    return <p className="muted">{t('runObservability.notApplicable')}</p>
  const coverage = value.state === 'ready' ? value : value.tokenCoverage
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.totalTokens')}</dt>
      <dd>
        <CompleteTokens value={value} compact={value.state === 'not-ready'} />
      </dd>
      <dt>{t('runObservability.cost')}</dt>
      <dd>
        <CompleteCost value={value} compact={value.state === 'not-ready'} />
      </dd>
      <dt>{t('runObservability.coverage')}</dt>
      <dd>
        {coverage?.invocations === '0' ? (
          t('runObservability.noRegisteredCalls')
        ) : coverage ? (
          <>
            {BigInt(coverage.observedInvocations).toLocaleString(i18n.language)} /{' '}
            {BigInt(coverage.invocations).toLocaleString(i18n.language)}
          </>
        ) : (
          t('runObservability.unknown')
        )}
      </dd>
      <dt>{t('runObservability.numericRecords')}</dt>
      <dd>
        {coverage
          ? BigInt(coverage.records).toLocaleString(i18n.language)
          : t('runObservability.unknown')}
      </dd>
      {coverage && BigInt(coverage.historicalReferences ?? '0') > 0n && (
        <>
          <dt>{t('runObservability.historicalReferences')}</dt>
          <dd>
            {BigInt(coverage.observedHistoricalReferences ?? '0').toLocaleString(i18n.language)} /{' '}
            {BigInt(coverage.historicalReferences!).toLocaleString(i18n.language)}
          </dd>
        </>
      )}
    </dl>
  )
}
