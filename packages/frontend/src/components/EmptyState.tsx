// RFC-035 PR3 — shared empty-state primitive. Replaces the
//   {data.length === 0 && <div className="muted">{t('common.empty')}</div>}
// pattern that was spread across ~9 list routes with no shared visual.

import type { ReactElement, ReactNode } from 'react'

export type EmptyStateSize = 'compact' | 'comfortable'

export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  size?: EmptyStateSize
  'data-testid'?: string
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  const size = props.size ?? 'comfortable'
  const classes = ['empty-state']
  if (size === 'compact') classes.push('empty-state--compact')
  return (
    <div className={classes.join(' ')} data-testid={props['data-testid'] ?? 'empty-state'}>
      {props.icon !== undefined && (
        <div className="empty-state__icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <div className="empty-state__title">{props.title}</div>
      {props.description !== undefined && (
        <div className="empty-state__description">{props.description}</div>
      )}
      {props.action !== undefined && <div className="empty-state__action">{props.action}</div>}
    </div>
  )
}
