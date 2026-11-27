// RFC-616 §11.2 — the shared metric tile (`.metric-tile` / `.metric-grid`).
//
// One number with its name, an optional explanation line (or several) and an
// optional change line against a comparison baseline. Used by the run
// observation overview and every process metrics view; a page never builds its
// own "big number in a box".
//
//   <div class="metric-grid[ metric-grid--compact]">
//     <div class="metric-tile">
//       <p class="metric-tile__label">…</p>
//       <p class="metric-tile__value">…</p>
//       <p class="metric-tile__detail">…</p>*
//       <p class="metric-tile__delta metric-tile__delta--good|bad|neutral">▲|▼ …</p>?
//
// A change is never shown by colour alone: the arrow gives the direction and
// the text says whether it is an improvement.

import type { ReactElement, ReactNode } from 'react'

export interface MetricDelta {
  /** Which way the number moved. */
  readonly direction: 'up' | 'down'
  /** Whether that movement is an improvement for this metric. */
  readonly tone: 'good' | 'bad' | 'neutral'
  /** The whole sentence after the arrow, e.g. "14% · 较上一时段（变好）". */
  readonly text: string
}

export interface MetricTileProps {
  label: string
  /** The number, already formatted. `—` (never 0) when there is no sample. */
  value: ReactNode
  /** One explanation line, or several. */
  detail?: ReactNode | readonly ReactNode[]
  delta?: MetricDelta | null
  testid?: string
}

const ARROW: Record<MetricDelta['direction'], string> = { up: '▲', down: '▼' }

function detailLines(detail: MetricTileProps['detail']): ReactNode[] {
  if (detail === undefined || detail === null || detail === false || detail === '') return []
  return Array.isArray(detail)
    ? (detail as readonly ReactNode[]).filter(
        (line) => line !== null && line !== undefined && line !== false && line !== '',
      )
    : [detail as ReactNode]
}

export function MetricTile(props: MetricTileProps): ReactElement {
  return (
    <div className="metric-tile" data-testid={props.testid}>
      <p className="metric-tile__label">{props.label}</p>
      <p className="metric-tile__value">{props.value}</p>
      {detailLines(props.detail).map((line, index) => (
        <p key={index} className="metric-tile__detail">
          {line}
        </p>
      ))}
      {props.delta ? (
        <p className={`metric-tile__delta metric-tile__delta--${props.delta.tone}`}>
          <span aria-hidden="true">{ARROW[props.delta.direction]} </span>
          {props.delta.text}
        </p>
      ) : null}
    </div>
  )
}

export function MetricGrid(props: {
  children: ReactNode
  /** Smaller tiles on the page surface, for a row of figures inside a card. */
  compact?: boolean
  testid?: string
}): ReactElement {
  return (
    <div
      className={props.compact === true ? 'metric-grid metric-grid--compact' : 'metric-grid'}
      data-testid={props.testid}
    >
      {props.children}
    </div>
  )
}
