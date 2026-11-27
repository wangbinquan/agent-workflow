// RFC-616 §11.2 — one measure over time as a line (`.trend-chart`).
//
// A single series: the card title names it, the last point is labelled
// directly, and the axis starts at zero. A period without a sample is a gap in
// the line, never a zero. Every period is a focusable hit area: hovering or
// focusing it draws a crosshair and puts the exact value in the readout line.
// The same numbers are in the data table under the chart.

import { useState, type ReactElement } from 'react'
import { TableViewport } from '@/components/TableViewport'
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth'
import { niceAxis } from './chartAxis'

export interface TrendChartPoint {
  readonly key: string
  /** The period, e.g. the first day of a week. */
  readonly label: string
  /** null: no sample in this period. */
  readonly value: number | null
  readonly valueText: string
}

const HEIGHT = 230
const LEFT = 52
const RIGHT = 64
const RIGHT_NARROW = 24
const TOP = 14
const BOTTOM = 30
const MIN_WIDTH = 280
const NARROW_BELOW = 480
const MAX_WIDTH = 1100
const DEFAULT_WIDTH = 640
const TICK_LABEL_PX = 52
const END_LABEL_GAP = 10

/**
 * The drawing width and its right margin for a measured container width.
 * The wide margin holds the label beside the last point. On a phone that margin would take a
 * fifth of the drawing and the label still would not fit, so the margin only keeps the last
 * dot and its period label inside and the value goes above the point.
 */
export function trendFrame(measured: number | null): { width: number; right: number } {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, measured ?? DEFAULT_WIDTH))
  return { width, right: width < NARROW_BELOW ? RIGHT_NARROW : RIGHT }
}

/** A rough width of a 12px label: CJK glyphs are square, Latin ones about half as wide. */
export function trendLabelPx(text: string): number {
  let px = 0
  for (const glyph of text) px += (glyph.codePointAt(0) ?? 0) > 0x2e7f ? 12 : 6.6
  return px
}

/**
 * The periods whose label is drawn under the axis: every `every`-th one and always the last.
 * A regular one too close to the last gives way to it, so the two never sit on each other.
 */
export function trendTickIndexes(count: number, every: number): number[] {
  const last = count - 1
  const shown: number[] = []
  for (let index = 0; index < count; index++)
    if (index === last || (index % every === 0 && last - index >= every)) shown.push(index)
  return shown
}

/** Runs of consecutive periods that have a value; a gap ends a run. */
export function trendRuns(values: readonly (number | null)[]): number[][] {
  const runs: number[][] = []
  let current: number[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current)
      current = []
    } else current.push(index)
  })
  if (current.length > 0) runs.push(current)
  return runs
}

export function TrendChart(props: {
  points: readonly TrendChartPoint[]
  /** Accessible name of the chart, also the caption of its data table. */
  label: string
  formatTick: (value: number) => string
  /** The toggle and the two column headers of the data table. */
  table: { readonly summary: string; readonly period: string; readonly value: string }
  testid?: string
}): ReactElement | null {
  const [wrapRef, measured] = useMeasuredWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const { points } = props
  const values = points.map((point) => point.value)
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return null
  const { width, right } = trendFrame(measured)
  const plot = width - LEFT - right
  const axis = niceAxis(Math.max(...known))
  const x = (index: number) =>
    points.length === 1 ? LEFT + plot / 2 : LEFT + (plot * index) / (points.length - 1)
  const y = (value: number) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - value / axis.top)
  const band = points.length === 1 ? plot : plot / (points.length - 1)
  const every = Math.max(
    1,
    Math.ceil(points.length / Math.max(1, Math.floor(plot / TICK_LABEL_PX))),
  )
  const lastKnown = values.reduce<number>(
    (last, value, index) => (value === null ? last : index),
    -1,
  )
  const shown = active === null ? undefined : points[active]
  const ticks = new Set(trendTickIndexes(points.length, every))
  // The last point is labelled beside it when the label fits in the margin; a long one (a
  // duration in words) would be cut off at the edge, so it goes above the point instead.
  const endText = lastKnown >= 0 ? points[lastKnown]!.valueText : ''
  const endFits =
    lastKnown >= 0 && x(lastKnown) + END_LABEL_GAP + trendLabelPx(endText) <= width - 2
  return (
    <div className="trend-chart-block" data-testid={props.testid}>
      <div ref={wrapRef} className="trend-chart__scroll">
        <svg
          className="trend-chart"
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="group"
          aria-label={props.label}
        >
          {axis.ticks.map((tick) => (
            <g key={tick} aria-hidden="true">
              <line
                className={tick === 0 ? 'trend-chart__axis' : 'trend-chart__grid'}
                x1={LEFT}
                x2={width - right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text x={LEFT - 8} y={y(tick) + 4} textAnchor="end">
                {props.formatTick(tick)}
              </text>
            </g>
          ))}
          {points.map((point, index) =>
            ticks.has(index) ? (
              <text
                key={point.key}
                x={x(index)}
                y={HEIGHT - 9}
                textAnchor="middle"
                aria-hidden="true"
              >
                {point.label}
              </text>
            ) : null,
          )}
          {trendRuns(values).map((run) => {
            const first = run[0]!
            const last = run[run.length - 1]!
            const line = run.map(
              (index) => `${x(index).toFixed(1)},${y(values[index]!).toFixed(1)}`,
            )
            return (
              <g key={first} aria-hidden="true">
                {run.length > 1 ? (
                  <>
                    <path
                      className="trend-chart__area"
                      d={`M${x(first).toFixed(1)},${y(0)} L${line.join(' L')} L${x(last).toFixed(1)},${y(0)} Z`}
                    />
                    <path className="trend-chart__line" d={`M${line.join(' L')}`} />
                  </>
                ) : (
                  // A period with no neighbours on either side is still a measurement.
                  <circle className="trend-chart__dot" cx={x(first)} cy={y(values[first]!)} r={4} />
                )}
              </g>
            )
          })}
          {active !== null ? (
            <line
              className="trend-chart__cross"
              x1={x(active)}
              x2={x(active)}
              y1={TOP}
              y2={y(0)}
              aria-hidden="true"
            />
          ) : null}
          {lastKnown >= 0 ? (
            <g aria-hidden="true">
              <circle
                className="trend-chart__dot"
                cx={x(lastKnown)}
                cy={y(values[lastKnown]!)}
                r={5}
              />
              <text
                className="trend-chart__end"
                x={x(lastKnown) + (endFits ? END_LABEL_GAP : 0)}
                y={endFits ? y(values[lastKnown]!) + 4 : Math.max(12, y(values[lastKnown]!) - 12)}
                textAnchor={endFits ? 'start' : 'end'}
              >
                {endText}
              </text>
            </g>
          ) : null}
          {points.map((point, index) => (
            <rect
              key={point.key}
              className="trend-chart__hit"
              x={x(index) - band / 2}
              y={TOP}
              width={band}
              height={HEIGHT - TOP - BOTTOM}
              tabIndex={0}
              role="img"
              aria-label={`${point.label}: ${point.valueText}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onMouseLeave={() => setActive((current) => (current === index ? null : current))}
              onBlur={() => setActive((current) => (current === index ? null : current))}
            />
          ))}
        </svg>
      </div>
      <p className="viz-readout" aria-live="polite">
        {shown ? `${shown.label}: ${shown.valueText}` : ''}
      </p>
      <details className="viz-table-toggle">
        <summary>{props.table.summary}</summary>
        <TableViewport label={props.label} minWidth="sm">
          <table className="data-table data-table--compact" aria-label={props.label}>
            <thead>
              <tr>
                <th scope="col">{props.table.period}</th>
                <th scope="col" className="viz-num">
                  {props.table.value}
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.key}>
                  <th scope="row">{point.label}</th>
                  <td className="viz-num">{point.valueText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </details>
    </div>
  )
}
