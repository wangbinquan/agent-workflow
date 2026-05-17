// RFC-035 PR3 — shared detail-page split-pane container.
//
// Replaces ad-hoc layouts:
//   - task-detail   `.task-detail__panes`
//   - review-detail `.review-detail__layout`
//
// The shared primitive owns the grid; consumers continue to own the
// content of `main` and `aside` (so the sidebar visual that RFC-009
// established for review-detail is preserved as-is, just inside the
// shared grid).

import type { ReactElement, ReactNode } from 'react'

export type DetailLayoutAsideWidth = 'sm' | 'md' | 'lg'
export type DetailLayoutAsidePosition = 'left' | 'right'

export interface DetailLayoutProps {
  main: ReactNode
  aside?: ReactNode
  asideWidth?: DetailLayoutAsideWidth
  asidePosition?: DetailLayoutAsidePosition
  'data-testid'?: string
  className?: string
}

export function DetailLayout(props: DetailLayoutProps): ReactElement {
  const width = props.asideWidth ?? 'md'
  const position = props.asidePosition ?? 'right'
  const hasAside = props.aside !== undefined
  const classes = ['detail-layout']
  if (hasAside) classes.push('detail-layout--has-aside', `detail-layout--aside-${width}`)
  if (hasAside && position === 'left') classes.push('detail-layout--aside-left')
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  return (
    <div className={classes.join(' ')} data-testid={props['data-testid']}>
      {hasAside && position === 'left' && (
        <aside className="detail-layout__aside">{props.aside}</aside>
      )}
      <div className="detail-layout__main">{props.main}</div>
      {hasAside && position === 'right' && (
        <aside className="detail-layout__aside">{props.aside}</aside>
      )}
    </div>
  )
}
