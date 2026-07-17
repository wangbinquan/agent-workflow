// Shared inline error banner used by list pages.
//
// RFC-203 T2: every error now flows through the three-tier resolver
// (resolveApiError) and the structured <ErrorDetails> renderer — callers get
// localized titles, next-step hints, known details shapes (zod issues /
// reference lists / available refs / OCC pairs / stderr) and a collapsible
// raw-message block for free. `overrides` forwards caller-local code→key
// maps (the DISPATCH_ERROR_KEYS pattern).

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveApiError } from '@/i18n/errors'
import { ErrorDetails } from './ErrorDetails'
import { NoticeBanner } from './NoticeBanner'

interface ErrorBannerProps {
  error: unknown
  message?: string
  action?: ReactNode
  onDismiss?: () => void
  overrides?: Record<string, string>
}

export function ErrorBanner({ error, message, action, onDismiss, overrides }: ErrorBannerProps) {
  const { t } = useTranslation()
  const resolved =
    error === null || error === undefined
      ? null
      : resolveApiError(error, overrides !== undefined ? { overrides } : undefined)
  const msg = message ?? (resolved === null ? t('common.unknownError') : resolved.title)
  const hasAction = action !== undefined && action !== null && action !== false
  return (
    <NoticeBanner
      tone="error"
      size="compact"
      action={action}
      dismiss={
        onDismiss === undefined ? undefined : { label: t('common.close'), onDismiss: onDismiss }
      }
      className={hasAction ? 'error-box error-banner--with-action' : 'error-box'}
    >
      {msg}
      {resolved !== null && (
        <ErrorDetails
          details={resolved.details}
          {...(resolved.hint !== undefined ? { hint: resolved.hint } : {})}
          {...(resolved.raw !== undefined && resolved.raw !== msg ? { raw: resolved.raw } : {})}
        />
      )}
    </NoticeBanner>
  )
}
