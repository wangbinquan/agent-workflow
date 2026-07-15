// Shared inline error banner used by list pages.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/client'

interface ErrorBannerProps {
  error: unknown
  message?: string
  action?: ReactNode
}

export function ErrorBanner({ error, message, action }: ErrorBannerProps) {
  const { t } = useTranslation()
  let msg = message ?? t('common.unknownError')
  if (message === undefined) {
    if (error instanceof ApiError) msg = `${error.code}: ${error.message}`
    else if (error instanceof Error) msg = error.message
  }
  const hasAction = action !== undefined && action !== null
  return (
    <div className={'error-box' + (hasAction ? ' error-banner--with-action' : '')} role="alert">
      {hasAction ? (
        <>
          <span>⚠ {msg}</span>
          {action}
        </>
      ) : (
        <>⚠ {msg}</>
      )}
    </div>
  )
}
