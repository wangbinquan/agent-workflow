// RFC-198 — shared page heading/action chrome.
//
// This component intentionally stays thin: routes own their title content,
// action hierarchy and state. PageHeader only supplies one consistent DOM
// shape and the h1/h2 choice required by top-level versus split-detail pages.

import type { ReactElement, ReactNode } from 'react'

export interface PageHeaderProps {
  title: ReactNode
  headingLevel?: 1 | 2
  meta?: ReactNode
  back?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  'data-testid'?: string
}

function isPresent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false
}

export function PageHeader(props: PageHeaderProps): ReactElement {
  const HeadingTag = props.headingLevel === 2 ? 'h2' : 'h1'
  const classes = ['page__header', 'page__header--row']
  if (props.className !== undefined && props.className !== '') classes.push(props.className)

  return (
    <header className={classes.join(' ')} data-testid={props['data-testid']}>
      <div className="page__heading">
        {isPresent(props.back) && props.back}
        <HeadingTag className="page__title">{props.title}</HeadingTag>
        {isPresent(props.meta) && <div className="page__meta">{props.meta}</div>}
        {isPresent(props.children) && props.children}
      </div>
      {isPresent(props.actions) && <div className="page__actions">{props.actions}</div>}
    </header>
  )
}
