import type { ReviewDetail } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'

/** A reviewer-only cached document must disappear as soon as the server revokes it. */
export function isReviewNodeAccessRevoked(
  detail: ReviewDetail | undefined,
  error: unknown,
): boolean {
  return (
    detail?.capabilities.scope === 'review-node' &&
    error instanceof ApiError &&
    (error.status === 403 || error.status === 404)
  )
}
