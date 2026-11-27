// RFC-616 §11.2 — the five-step heat legend (`.heat-scale`) and the class that
// paints a cell with one step (`.viz-heat--N`).
//
// Values are binned by rank, not by value (see `processRankBins` in shared), so
// one extreme value does not flatten everything else into the lightest step.
// The legend therefore names the lowest and highest value rather than a scale.

import type { ReactElement } from 'react'

export type HeatLevel = 1 | 2 | 3 | 4 | 5

export const HEAT_LEVELS: readonly HeatLevel[] = [1, 2, 3, 4, 5]

/** The fill class of one step; empty for "not applicable" (level 0 / null). */
export function heatClassName(level: number | null | undefined): string {
  return level === 1 || level === 2 || level === 3 || level === 4 || level === 5
    ? `viz-heat--${level}`
    : ''
}

export function HeatScale(props: {
  /** Text at the light end, e.g. "低 3 分". */
  lowLabel: string
  /** Text at the dark end, e.g. "高 46 分". */
  highLabel: string
  /** How to read the scale, e.g. "按数值从低到高分五档；没有颜色的不适用这个指标". */
  note?: string
  testid?: string
}): ReactElement {
  return (
    <div className="heat-scale" data-testid={props.testid}>
      <span>{props.lowLabel}</span>
      <span className="heat-scale__steps" aria-hidden="true">
        {HEAT_LEVELS.map((level) => (
          <i key={level} className={heatClassName(level)} />
        ))}
      </span>
      <span>{props.highLabel}</span>
      {props.note ? <span className="heat-scale__note">{props.note}</span> : null}
    </div>
  )
}
