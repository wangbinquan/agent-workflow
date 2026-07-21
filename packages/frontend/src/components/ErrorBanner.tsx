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
  /** RFC-214: when set and no explicit `action`, render the canonical retry
   *  button (`.btn .btn--sm`) into the action slot. Explicit `action` wins,
   *  so RFC-203's existing action-slot callers are unaffected. */
  onRetry?: () => void
  /** RFC-214: overrides the retry button label (default `common.retry`). */
  retryLabel?: string
  onDismiss?: () => void
  overrides?: Record<string, string>
  /** Root data-testid passthrough (RFC-203 T5b migrations keep anchors). */
  testid?: string
}

export function ErrorBanner({
  error,
  message,
  action,
  onRetry,
  retryLabel,
  onDismiss,
  overrides,
  testid,
}: ErrorBannerProps) {
  const { t } = useTranslation()
  const resolved =
    error === null || error === undefined
      ? null
      : resolveApiError(error, overrides !== undefined ? { overrides } : undefined)
  const msg = message ?? (resolved === null ? t('common.unknownError') : resolved.title)
  // RFC-214: explicit `action` always wins (RFC-203 back-compat); otherwise
  // `onRetry` materializes the one canonical retry button.
  const explicitAction = action !== undefined && action !== null && action !== false
  const resolvedAction: ReactNode = explicitAction ? (
    action
  ) : onRetry !== undefined ? (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => {
        onRetry()
      }}
    >
      {retryLabel ?? t('common.retry')}
    </button>
  ) : undefined
  // MAJOR-5: className/hasAction must reflect resolvedAction (= explicit action
  // OR the materialized onRetry button), else an onRetry-only banner loses the
  // `error-banner--with-action` flex layout.
  const hasAction = explicitAction || onRetry !== undefined
  return (
    <NoticeBanner
      tone="error"
      size="compact"
      action={resolvedAction}
      dismiss={
        onDismiss === undefined ? undefined : { label: t('common.close'), onDismiss: onDismiss }
      }
      className={hasAction ? 'error-box error-banner--with-action' : 'error-box'}
      testid={testid}
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
