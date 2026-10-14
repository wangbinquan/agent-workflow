// RFC-371 v2 §6 — tokens per day stacked by category. Every day is a button:
// hovering or focusing it shows the exact values in a live readout, so the
// numbers never depend on seeing the bars.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationDay } from '@agent-workflow/shared'
import { formatObservationCny } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { formatCount, tokenTotal } from './observationFormat'

const SEGMENTS = [
  ['input', 'input'],
  ['cacheRead', 'cache-read'],
  ['cacheWrite', 'cache-write'],
  ['output', 'output'],
] as const

export function ObservationDailyChart({ days }: { days: readonly ObservationDay[] }) {
  const { t, i18n } = useTranslation()
  const [active, setActive] = useState<string | null>(null)
  const peak = Math.max(1, ...days.map((day) => tokenTotal(day)))
  const describe = (day: ObservationDay) =>
    t('runObservability.dailyBar', {
      day: day.day,
      calls: formatCount(day.calls, i18n.language),
      input: formatCount(day.input, i18n.language),
      cacheRead: formatCount(day.cacheRead, i18n.language),
      cacheWrite: formatCount(day.cacheWrite, i18n.language),
      output: formatCount(day.output, i18n.language),
      cost: formatObservationCny(day.costNano),
    })
  const shown = days.find((day) => day.day === active)
  if (days.every((day) => day.calls === 0))
    return <EmptyState title={t('runObservability.dailyEmpty')} size="compact" />
  return (
    <div className="stack--sm">
      <ul className="observability-chart__legend">
        {SEGMENTS.map(([key, tone]) => (
          <li key={key}>
            <span className={`observability-swatch--${tone}`} aria-hidden="true" />
            {t(`runObservability.${key}`)}
          </li>
        ))}
      </ul>
      <div
        className="observability-chart"
        role="group"
        aria-label={t('runObservability.dailyTitle')}
      >
        {days.map((day) => (
          <button
            key={day.day}
            type="button"
            className="observability-chart__day"
            aria-label={describe(day)}
            aria-pressed={active === day.day}
            title={describe(day)}
            onMouseEnter={() => setActive(day.day)}
            onFocus={() => setActive(day.day)}
            onClick={() => setActive(day.day)}
          >
            <span className="observability-chart__stack" aria-hidden="true">
              {SEGMENTS.map(([key, tone]) =>
                day[key] > 0 ? (
                  <span
                    key={key}
                    className={`observability-swatch--${tone}`}
                    style={{ height: `${(day[key] / peak) * 100}%` }}
                  />
                ) : null,
              )}
            </span>
            <span className="observability-chart__label" aria-hidden="true">
              {day.day.slice(5)}
            </span>
          </button>
        ))}
      </div>
      <p className="observability-chart__readout" aria-live="polite">
        {shown ? describe(shown) : ''}
      </p>
    </div>
  )
}
