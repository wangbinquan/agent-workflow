import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationMetrics } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'
import {
  formatObservationCny,
  formatObservationBucket,
  OBSERVATION_TOKEN_BUCKETS as keys,
} from './formatObservations'
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
  'native-capture-pending': 'nativeState_pending',
  'native-capture-partial': 'nativeState_partial',
  'native-capture-unobserved': 'nativeState_unobserved',
  'native-capture-unsupported': 'nativeState_unsupported',
  'native-turn-gap': 'nativeTurnGap',
  'native-baseline-not-started': 'nativeBaselineMissing',
  'native-baseline-unavailable': 'nativeBaselineMissing',
  'native-root-changed': 'nativeRootChanged',
  'native-root-unavailable': 'nativeRootMissing',
  'native-tree-conflict': 'nativeTreeConflict',
  'native-step-identity': 'nativeTreeConflict',
  'native-prior-revision-gap': 'nativePriorRevision',
  'native-prior-revision-budget': 'nativeScanLimit',
  'native-store-unavailable': 'nativeStoreUnavailable',
  'native-model-unavailable': 'modelUnknown',
  'native-token-bucket-unknown': 'usagePartial',
  'native-time-unavailable': 'nativeTimeUnknown',
  'native-tree-budget': 'nativeScanLimit',
  'native-step-budget': 'nativeScanLimit',
  'native-part-budget': 'nativeScanLimit',
  'native-scan-budget': 'nativeScanLimit',
  'native-output-incomplete': 'nativeOutputIncomplete',
  'native-step-unfinished': 'nativeOutputIncomplete',
}
export function TokenBuckets({ metrics }: { metrics: ObservationMetrics }) {
  const { t, i18n } = useTranslation()
  return (
    <dl
      className="observation-token-buckets"
      data-token-buckets
      aria-label={t('runObservability.buckets')}
    >
      {keys.map((bucket) => (
        <div key={bucket} data-token-bucket={bucket}>
          <dt>{t(`runObservability.${bucket}`)}</dt>
          <dd>
            {formatObservationBucket(metrics, bucket, i18n.language) ??
              t('runObservability.unknown')}
          </dd>
        </div>
      ))}
    </dl>
  )
}
export function Tokens({
  metrics,
  breakdown = true,
}: {
  metrics: ObservationMetrics
  breakdown?: boolean
}) {
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
      {breakdown && <TokenBuckets metrics={metrics} />}
    </>
  )
}
export function Cost({ metrics, exact = false }: { metrics: ObservationMetrics; exact?: boolean }) {
  const { t } = useTranslation()
  return (
    <>
      <strong>{formatObservationCny(metrics.cost.knownAmount, exact)}</strong>{' '}
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
        <Tokens metrics={value} breakdown={false} />
      </dd>
      {keys.map((key) => (
        <Fragment key={key}>
          <dt>{t(`runObservability.${key}`)}</dt>
          <dd>
            {formatObservationBucket(value, key, i18n.language) ?? t('runObservability.unknown')}
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
