// RFC-371 v2 §6 — the four token columns and the CNY column shared by every
// observation table. Tokens stay in separate columns instead of per-row labels.
import { useTranslation } from 'react-i18next'
import type { ObservationUsage } from '@agent-workflow/shared'
import { formatCount, usageCost } from './observationFormat'

export function UsageHeaderCells() {
  const { t } = useTranslation()
  return (
    <>
      {(['input', 'cacheRead', 'cacheWrite', 'output', 'cost'] as const).map((key) => (
        <th key={key} scope="col" className="observability__num">
          {t(`runObservability.${key}`)}
        </th>
      ))}
    </>
  )
}

export function UsageCells({ usage }: { usage: ObservationUsage }) {
  const { t, i18n } = useTranslation()
  const lowerBound = usage.incompleteCalls > 0
  return (
    <>
      {([usage.input, usage.cacheRead, usage.cacheWrite, usage.output] as const).map(
        (value, index) => (
          <td key={index} className="observability__num">
            {formatCount(value, i18n.language)}
            {lowerBound && index === 0 ? (
              <span className="muted" title={t('runObservability.lowerBoundHint')}>
                {' '}
                ({t('runObservability.lowerBound')})
              </span>
            ) : null}
          </td>
        ),
      )}
      <td
        className="observability__num"
        title={usage.unpricedCalls > 0 ? t('runObservability.partialCostHint') : undefined}
      >
        {usageCost(usage, t)}
      </td>
    </>
  )
}
