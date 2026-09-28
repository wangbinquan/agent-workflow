import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationMetrics } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'
import { formatObservationCny } from './formatObservations'

const keys = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
const reasonKeys: Readonly<Record<string, string>> = {
  'not-observed': 'unknown',
  unpriced: 'unpriced',
  pending: 'pending',
  'not-authorized': 'hidden',
  'partial-price': 'pricingPartial',
  'usage-partial': 'usagePartial',
  'model-unknown': 'modelUnknown',
  'registration-unknown': 'registrationUnknown',
  'partial-allocation': 'allocationPartial',
  'coverage-partial': 'coveragePartial',
  'coverage-conflict': 'coverageConflict',
  'capture-gap': 'sourceGap',
  initial: 'sourceInitial',
  syncing: 'sourceSyncing',
  failed: 'sourceFailed',
  'legacy-unbound': 'sourceUnbound',
  truncated: 'limitHint',
}
export function Tokens({ metrics }: { metrics: ObservationMetrics }) {
  const { t, i18n } = useTranslation()
  return (
    <>
      <strong>
        {metrics.tokens.hasKnown
          ? BigInt(metrics.tokens.totalKnown).toLocaleString(i18n.language)
          : '—'}
      </strong>{' '}
      {!metrics.tokens.complete && (
        <StatusChip kind="warn" size="sm">
          {t(`runObservability.${metrics.tokens.hasKnown ? 'partial' : 'unknown'}`)}
        </StatusChip>
      )}
    </>
  )
}
export function Cost({ metrics }: { metrics: ObservationMetrics }) {
  const { t } = useTranslation()
  return (
    <>
      <strong>{formatObservationCny(metrics.cost.knownAmount)}</strong>{' '}
      {!metrics.cost.complete && (
        <StatusChip kind="warn" size="sm">
          {t('runObservability.partial')}
        </StatusChip>
      )}
    </>
  )
}
export function Source({ metrics }: { metrics: ObservationMetrics }) {
  const { t } = useTranslation()
  return (
    <>
      {metrics.authorities.length
        ? metrics.authorities.map((a) => t(`runObservability.${a}`)).join(' · ')
        : '—'}
    </>
  )
}
export function Metrics({ value }: { value: ObservationMetrics }) {
  const { t, i18n } = useTranslation()
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.tokens')}</dt>
      <dd>
        <Tokens metrics={value} />
      </dd>
      {keys.map((key) => (
        <Fragment key={key}>
          <dt>{t(`runObservability.${key}`)}</dt>
          <dd>
            {value.records === 0 || value.tokens.unknownBuckets[key] === value.records
              ? '—'
              : BigInt(value.tokens.known[key]).toLocaleString(i18n.language)}
          </dd>
        </Fragment>
      ))}
      <dt>{t('runObservability.cost')}</dt>
      <dd>
        <Cost metrics={value} />
      </dd>
      <dt>{t('runObservability.coverage')}</dt>
      <dd>
        {value.observedInvocations} / {value.invocations}
      </dd>
      <dt>{t('runObservability.source')}</dt>
      <dd>
        <Source metrics={value} />
      </dd>
      <dt>{t('runObservability.prices')}</dt>
      <dd>
        {value.cost.priceVersionIds.length
          ? value.cost.priceVersionIds.join(' · ')
          : t('runObservability.noPrices')}
      </dd>
      {value.cost.reasons.length > 0 && (
        <>
          <dt>{t('runObservability.state')}</dt>
          <dd>
            {value.cost.reasons
              .map((r) => t(`runObservability.${reasonKeys[r] ?? 'partial'}`))
              .join(' · ')}
          </dd>
        </>
      )}
    </dl>
  )
}
export const observationReasonKey = (reason: string) => reasonKeys[reason] ?? 'partial'
