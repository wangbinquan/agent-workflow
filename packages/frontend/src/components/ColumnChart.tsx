// RFC-616 §11.2 — one measure over an ordered category (`.column-chart`):
// comments per review round, assignments per workgroup round.
//
// Every column is a button carrying its exact value in its accessible name and
// printed above the bar; hovering or focusing it repeats the value, with the
// column's note, in the readout line. One series, so no legend: the card title
// names it.

import { useState, type CSSProperties, type ReactElement } from 'react'
import { niceAxis } from './chartAxis'

export interface ColumnChartItem {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly valueText: string
  /** Extra context for the readout, e.g. "21 个任务跑到这一轮". */
  readonly note?: string
}

export function ColumnChart(props: {
  items: readonly ColumnChartItem[]
  /** Accessible name of the chart. */
  label: string
  testid?: string
}): ReactElement | null {
  const [active, setActive] = useState<string | null>(null)
  if (props.items.length === 0) return null
  const top = niceAxis(Math.max(...props.items.map((item) => item.value))).top
  const describe = (item: ColumnChartItem) =>
    `${item.label}: ${item.valueText}${item.note ? ` · ${item.note}` : ''}`
  const shown = props.items.find((item) => item.key === active)
  return (
    <div className="column-chart-block" data-testid={props.testid}>
      <div className="column-chart" role="group" aria-label={props.label}>
        {props.items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="column-chart__col"
            aria-label={describe(item)}
            title={describe(item)}
            onMouseEnter={() => setActive(item.key)}
            onFocus={() => setActive(item.key)}
            onMouseLeave={() => setActive((current) => (current === item.key ? null : current))}
            onBlur={() => setActive((current) => (current === item.key ? null : current))}
          >
            <span className="column-chart__track" aria-hidden="true">
              <span className="column-chart__value">{item.valueText}</span>
              <span
                className="column-chart__bar"
                style={{ '--ratio': Math.max(0, item.value) / top } as CSSProperties}
              />
            </span>
            <span className="column-chart__label" aria-hidden="true">
              {item.label}
            </span>
          </button>
        ))}
      </div>
      <p className="viz-readout" aria-live="polite">
        {shown ? describe(shown) : ''}
      </p>
    </div>
  )
}
