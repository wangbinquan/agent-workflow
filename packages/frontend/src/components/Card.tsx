// RFC-124 — shared card primitive.
//
// One reusable card shell for the app, modeled on the nicest existing pattern
// (`.clarify-question`, styles.css). Three slots — `header` / body (`children`)
// / `footer` — plus `interactive` (hover affordance) and `highlighted`
// (accent-tinted selected state) modifiers. Token-based `.card*` styling lives
// in styles.css.
//
// RFC-124 only wires the task-questions board onto it; clarify / memory /
// resource cards stay on their bespoke CSS and migrate in a follow-up.

import type { ReactElement, ReactNode } from 'react'

export interface CardProps {
  /** Optional header slot (e.g. selection checkbox / badges), above the body. */
  header?: ReactNode
  /** Body content (title / answer / meta …). */
  children: ReactNode
  /** Optional footer slot for actions; visually separated below the body. */
  footer?: ReactNode
  /** Hover affordance (accent border + soft shadow). Default false. */
  interactive?: boolean
  /** Accent-tinted background + border (e.g. selected). Default false. */
  highlighted?: boolean
  /** Extra classes appended after the standard `.card` chain. */
  className?: string
  'data-testid'?: string
}

export function Card(props: CardProps): ReactElement {
  const classes = ['card']
  if (props.interactive === true) classes.push('card--interactive')
  if (props.highlighted === true) classes.push('card--highlighted')
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  // Treat undefined / null / false slots as absent so the common JSX pattern
  // `header={cond && node}` (which yields `false` when cond is falsy) does not
  // render an empty `.card__header` / `.card__footer` wrapper (RFC-124 Codex P3).
  const hasHeader = props.header != null && props.header !== false
  const hasFooter = props.footer != null && props.footer !== false
  return (
    <div className={classes.join(' ')} data-testid={props['data-testid']}>
      {hasHeader && <div className="card__header">{props.header}</div>}
      <div className="card__body">{props.children}</div>
      {hasFooter && <div className="card__footer">{props.footer}</div>}
    </div>
  )
}
