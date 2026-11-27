// RFC-616 §11.2 — one whole split into parts (`.segbar` / `.viz-legend`).
//
// Two forms of the same mark:
//   · tall  — a 28px bar whose parts are focusable; the share is printed inside
//             a part when it fits and left out when it does not;
//   · thin  — an 8px bar for a table row, read as one image.
// Every part's exact value is in the legend (`SegmentedBarLegend`) or in the
// table the bar sits in, and hovering or focusing a part of the tall bar shows
// it in the readout line, so nothing depends on seeing the colours.
//
// At most four categorical fills; anything beyond that is folded by the caller
// into one muted `other` part. Colours come from the `--viz-*` tokens only.

import { useState, type ReactElement } from 'react'
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth'

export type VizFill =
  | 'cat-1'
  | 'cat-2'
  | 'cat-3'
  | 'cat-4'
  | 'other'
  | 'ord-1'
  | 'ord-2'
  | 'ord-3'
  | 'good'
  | 'warn'
  | 'crit'

export interface SegmentedBarPart {
  readonly key: string
  readonly label: string
  /** Size of the part; any non-negative number, only proportions matter. */
  readonly amount: number
  /** The part's own value, formatted (a duration, a token count, a count). */
  readonly valueText: string
  readonly fill: VizFill
}

export interface SegmentedBarShare extends SegmentedBarPart {
  /** Fraction of the whole, 0–1. */
  readonly share: number
  readonly shareText: string
}

const PERCENT_LABEL_CHAR_PX = 7
const SEGMENT_PADDING_PX = 16

/** Parts with their share of the whole; a whole of zero has no shares. */
export function segmentedBarShares(parts: readonly SegmentedBarPart[]): SegmentedBarShare[] {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.amount), 0)
  return parts.map((part) => {
    const share = total > 0 ? Math.max(0, part.amount) / total : 0
    return { ...part, share, shareText: `${Math.round(share * 100)}%` }
  })
}

/** "value · share", or just one of them when they are the same text. */
export function segmentValueText(part: SegmentedBarShare): string {
  return part.valueText === part.shareText
    ? part.shareText
    : `${part.valueText} · ${part.shareText}`
}

/** Whether a share label fits inside its part of a bar this wide. */
export function segmentLabelFits(share: number, barWidth: number, labelText: string): boolean {
  return share * barWidth >= labelText.length * PERCENT_LABEL_CHAR_PX + SEGMENT_PADDING_PX
}

export function SegmentedBar(props: {
  parts: readonly SegmentedBarPart[]
  /** Accessible name of the whole bar. */
  label: string
  variant?: 'tall' | 'thin'
  testid?: string
}): ReactElement | null {
  const shares = segmentedBarShares(props.parts).filter((part) => part.share > 0)
  const [barRef, width] = useMeasuredWidth<HTMLDivElement>()
  const [active, setActive] = useState<string | null>(null)
  if (shares.length === 0) return null
  if (props.variant === 'thin') {
    return (
      <span
        className="segbar segbar--thin"
        role="img"
        aria-label={`${props.label}: ${shares.map((part) => `${part.label} ${part.shareText}`).join(', ')}`}
        data-testid={props.testid}
      >
        {shares.map((part) => (
          <span
            key={part.key}
            className={`segbar__seg viz-fill--${part.fill}`}
            style={{ flexGrow: part.share }}
            title={`${part.label}: ${segmentValueText(part)}`}
          />
        ))}
      </span>
    )
  }
  const shown = shares.find((part) => part.key === active)
  return (
    <div className="segbar-block" data-testid={props.testid}>
      <div ref={barRef} className="segbar" role="group" aria-label={props.label}>
        {shares.map((part) => {
          const text = `${part.label}: ${segmentValueText(part)}`
          // Before the first measurement (and where layout cannot be measured) only clearly wide parts are labelled.
          const fits =
            width === null
              ? part.share >= 0.12
              : segmentLabelFits(part.share, width, part.shareText)
          return (
            <button
              key={part.key}
              type="button"
              className={`segbar__seg viz-fill--${part.fill}`}
              style={{ flexGrow: part.share }}
              aria-label={text}
              title={text}
              data-tight={fits ? undefined : 'true'}
              onMouseEnter={() => setActive(part.key)}
              onFocus={() => setActive(part.key)}
              onMouseLeave={() => setActive((current) => (current === part.key ? null : current))}
              onBlur={() => setActive((current) => (current === part.key ? null : current))}
            >
              {fits ? (
                <span className="segbar__label" aria-hidden="true">
                  {part.shareText}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      <p className="viz-readout" aria-live="polite">
        {shown ? `${shown.label}: ${segmentValueText(shown)}` : ''}
      </p>
    </div>
  )
}

/**
 * The legend of a segmented bar. `stack` lists every part with its value and
 * share (the bar's table twin); `row` only names the fills, for a bar repeated
 * in every row of a table.
 */
export function SegmentedBarLegend(props: {
  parts: readonly SegmentedBarPart[]
  layout?: 'stack' | 'row'
  testid?: string
}): ReactElement {
  const shares = segmentedBarShares(props.parts)
  const stack = props.layout !== 'row'
  return (
    <ul
      className={stack ? 'viz-legend viz-legend--stack' : 'viz-legend'}
      data-testid={props.testid}
    >
      {shares.map((part) => (
        <li key={part.key}>
          <span className="viz-legend__key">
            <i className={`viz-legend__swatch viz-fill--${part.fill}`} aria-hidden="true" />
            {part.label}
          </span>
          {stack ? <span className="viz-legend__value">{segmentValueText(part)}</span> : null}
        </li>
      ))}
    </ul>
  )
}
