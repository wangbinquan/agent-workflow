import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ObservationStorageSchema } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'
import { Card } from '@/components/Card'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
export function ObservationStorage() {
  const { t, i18n } = useTranslation(),
    allowed = usePermission('settings:write'),
    query = useQuery({
      queryKey: ['observation-storage'],
      enabled: allowed,
      queryFn: async () =>
        ObservationStorageSchema.parse(await api.get('/api/observability/storage')),
      refetchInterval: 30000,
    }),
    data = query.error ? undefined : query.data
  const bytes = (n: string | null) =>
      n === null
        ? t('runObservability.storageUnknown')
        : `${(Number((BigInt(n) * 100n) / 1048576n) / 100).toLocaleString(i18n.language)} MiB`,
    date = (n: number | null) => (n === null ? '—' : new Date(n).toLocaleString(i18n.language))
  if (!allowed) return null
  return (
    <Card title={t('runObservability.storageTitle')}>
      {query.isPending ? <LoadingState /> : null}
      {query.error ? <ErrorBanner error={query.error} /> : null}
      {data ? (
        <>
          <dl className="detail-grid observation-metrics">
            <dt>{t('runObservability.storageDatabase')}</dt>
            <dd>{bytes(data.databaseBytes)}</dd>
            <dt>{t('runObservability.storageFacts')}</dt>
            <dd>{bytes(data.factsBytes)}</dd>
            <dt>{t('runObservability.storageDerived')}</dt>
            <dd>{bytes(data.derivedBytes)}</dd>
            <dt>{t('runObservability.storageIndexes')}</dt>
            <dd>{bytes(data.indexBytes)}</dd>
            <dt>{t('runObservability.storageReusable')}</dt>
            <dd>{bytes(data.reusableBytes)}</dd>
            <dt>{t('runObservability.storageFree')}</dt>
            <dd>{bytes(data.freeBytes)}</dd>
            <dt>{t('runObservability.storageGrowth')}</dt>
            <dd>{bytes(data.growthBytesPerDay)}</dd>
            <dt>{t('runObservability.storageDays')}</dt>
            <dd>{data.daysRemaining ?? t('runObservability.storageUnknown')}</dd>
            <dt>{t('runObservability.storageQueue')}</dt>
            <dd>
              {data.pending} · {date(data.oldestPendingAt)}
            </dd>
            <dt>{t('runObservability.storageReports')}</dt>
            <dd>
              {data.activeReports} / {data.retiringReports}
            </dd>
            <dt>{t('runObservability.storageReclaimed')}</dt>
            <dd>
              {data.reclaimed} · {date(data.lastSuccess)}
            </dd>
            <dt>{t('runObservability.storageSampled')}</dt>
            <dd>{date(data.sampledAt)}</dd>
          </dl>
          {data.lastError ? (
            <p role="status">
              {t('runObservability.storageRetry')}: {data.lastError}
            </p>
          ) : null}
          {data.daysRemaining !== null && data.daysRemaining < 7 ? (
            <p role="status">{t('runObservability.storagePressure')}</p>
          ) : null}
          <p className="hint">{t('runObservability.storagePolicy')}</p>
        </>
      ) : null}
    </Card>
  )
}
