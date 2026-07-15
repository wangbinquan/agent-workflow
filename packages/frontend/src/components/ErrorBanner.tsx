// Shared inline error banner used by list pages.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { describeApiError } from '@/i18n'
import { NoticeBanner } from './NoticeBanner'

interface ErrorBannerProps {
  error: unknown
  message?: string
  action?: ReactNode
}

export function ErrorBanner({ error, message, action }: ErrorBannerProps) {
  const { t } = useTranslation()
  const msg =
    message ??
    (error === null || error === undefined ? t('common.unknownError') : describeApiError(error))
  const hasAction = action !== undefined && action !== null && action !== false
  return (
    <NoticeBanner
      tone="error"
      size="compact"
      action={action}
      className={hasAction ? 'error-box error-banner--with-action' : 'error-box'}
    >
      {msg}
    </NoticeBanner>
  )
}
