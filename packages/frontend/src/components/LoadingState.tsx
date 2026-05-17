// RFC-035 PR3 — shared loading-state primitive. Replaces the inline
//   {isLoading && <div className="muted">{t('common.loading')}</div>}
// pattern that was spread across ~9 list routes.

import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'

export type LoadingStateSize = 'compact' | 'comfortable'

export interface LoadingStateProps {
  label?: string
  size?: LoadingStateSize
  'data-testid'?: string
}

export function LoadingState(props: LoadingStateProps): ReactElement {
  const { t } = useTranslation()
  const size = props.size ?? 'comfortable'
  const classes = ['loading-state']
  if (size === 'compact') classes.push('loading-state--compact')
  const label = props.label ?? t('common.loading')
  return (
    <div
      className={classes.join(' ')}
      role="status"
      aria-live="polite"
      data-testid={props['data-testid'] ?? 'loading-state'}
    >
      <div className="loading-state__spinner" aria-hidden="true" />
      <div className="loading-state__label">{label}</div>
    </div>
  )
}
