// RFC-616 §11.2 — a share drawn as a short bar inside a table cell (`.meter`).
//
// The number is the content; the bar only lets the eye rank a column. So the
// bar is decorative and the value is ordinary text. `null` (no sample) renders
// the same dash every other empty cell uses, never an empty bar that reads as 0.

import type { ReactElement } from 'react'

export function MeterBar(props: {
  /** Fraction 0–1; null when there is no sample. */
  share: number | null
  /** The text next to the bar; defaults to the rounded percentage. */
  valueText?: string
  testid?: string
}): ReactElement {
  if (props.share === null || !Number.isFinite(props.share)) {
    return <span data-testid={props.testid}>—</span>
  }
  const share = Math.min(1, Math.max(0, props.share))
  return (
    <span className="meter" data-testid={props.testid}>
      <span className="meter__track" aria-hidden="true">
        <span className="meter__bar" style={{ width: `${Math.max(1, share * 100)}%` }} />
      </span>
      <span className="meter__value">{props.valueText ?? `${Math.round(share * 100)}%`}</span>
    </span>
  )
}
