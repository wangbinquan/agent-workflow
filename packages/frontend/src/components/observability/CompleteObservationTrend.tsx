import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { CompleteObservationTrend as Trend } from '@agent-workflow/shared'
import { OBSERVATION_TOKEN_BUCKETS } from './formatObservations'
import { TableViewport } from '@/components/TableViewport'
import { EmptyState } from '@/components/EmptyState'
import { CompleteTokens } from './CompleteObservationMetrics'

export function CompleteObservationTrend({
  rows,
  onRange,
}: {
  rows: readonly Trend[]
  onRange: (from: number, to: number) => void
}) {
  const { t, i18n } = useTranslation()
  const [activeKey, setActiveKey] = useState<string | null>(null)
  if (!rows.length) return <EmptyState title={t('runObservability.empty')} size="compact" />
  const active = rows.find((row) => row.key === activeKey) ?? rows[0]!
  const values = rows.map((row) =>
    row.metrics.state === 'ready' ? BigInt(row.metrics.tokens.total) : 0n,
  )
  const maximum = values.reduce((left, right) => (left > right ? left : right), 1n)
  const taskMaximum = rows.reduce(
    (left, row) => (left > BigInt(row.tasks) ? left : BigInt(row.tasks)),
    1n,
  )
  const height = (value: bigint, max: bigint) => Number((value * 10000n) / max) / 100
  return (
    <div className="stack--sm">
      <TableViewport label={t('runObservability.trend')}>
        <ul className="observation-trend" data-observation-trend>
          {rows.map((row, index) => {
            const value = values[index]!
            return (
              <li key={row.key}>
                <button
                  type="button"
                  className="btn btn--ghost observation-trend__button"
                  aria-label={[
                    t('runObservability.exactTaskCount', {
                      tasks: BigInt(row.tasks).toLocaleString(i18n.language),
                    }),
                    row.metrics.state === 'ready'
                      ? value.toLocaleString(i18n.language) + ' Token'
                      : t('runObservability.notApplicable'),
                    ...OBSERVATION_TOKEN_BUCKETS.map(
                      (bucket) =>
                        t('runObservability.' + bucket) +
                        ' ' +
                        (row.metrics.state === 'ready'
                          ? BigInt(row.metrics.tokens[bucket]).toLocaleString(i18n.language)
                          : '—'),
                    ),
                    row.key,
                  ].join(' · ')}
                  onFocus={() => setActiveKey(row.key)}
                  onMouseEnter={() => setActiveKey(row.key)}
                  onClick={() => onRange(row.from, row.to)}
                >
                  <span className="observation-trend__values">
                    <span>
                      {t('runObservability.exactTaskCount', {
                        tasks: BigInt(row.tasks).toLocaleString(i18n.language),
                      })}
                    </span>
                    <strong>
                      {row.metrics.state === 'ready'
                        ? value.toLocaleString(i18n.language) + ' Token'
                        : t('runObservability.notApplicable')}
                    </strong>
                  </span>
                  <span className="observation-trend__track" aria-hidden="true">
                    <span
                      className="complete-observation-task-bar"
                      style={{ height: height(BigInt(row.tasks), taskMaximum) + '%' }}
                    />
                    <span
                      className="observation-trend__bar"
                      data-positive={value > 0n}
                      style={{ height: height(value, maximum) + '%' }}
                    >
                      {row.metrics.state === 'ready' &&
                        OBSERVATION_TOKEN_BUCKETS.map((bucket) => (
                          <span
                            key={bucket}
                            className="observation-trend__segment"
                            data-token-color={bucket}
                            style={{
                              height:
                                value === 0n
                                  ? 0
                                  : height(
                                      BigInt(
                                        row.metrics.state === 'ready'
                                          ? row.metrics.tokens[bucket]
                                          : '0',
                                      ),
                                      value,
                                    ) + '%',
                            }}
                          />
                        ))}
                    </span>
                  </span>
                  <span className="observation-trend__label">{row.key}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </TableViewport>
      <div
        role="group"
        aria-label={t('runObservability.trendInterval')}
        className="observation-trend__detail"
      >
        <p className="muted">
          {new Date(active.from).toLocaleString(i18n.language)} —{' '}
          {new Date(active.to).toLocaleString(i18n.language)}
        </p>
        <CompleteTokens value={active.metrics} />
      </div>
    </div>
  )
}
