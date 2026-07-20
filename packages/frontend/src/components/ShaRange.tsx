// RFC-210 — "old sha → new sha" display primitive.
//
// Short-sha rendering existed in three places with two different lengths
// (`slice(0, 12)` on the task detail and plugin detail pages, `slice(0, 10)` in
// the MCP inventory panel) and no shared component. This settles on 12 and gives
// the arrow form — which had no precedent at all — one place to live, so the
// next feature that needs it does not invent a fourth variant.
//
// Both endpoints are optional: a submodule that failed before committing has no
// "to" sha, and a newly added one has no "from". Missing values render as an
// em dash rather than an empty gap.

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/** Shared truncation length. 12 hex chars is unambiguous in any real repo. */
export const SHORT_SHA_LEN = 12

export function shortSha(sha: string | null | undefined): string | null {
  if (sha === null || sha === undefined || sha === '') return null
  return sha.slice(0, SHORT_SHA_LEN)
}

export interface ShaRangeProps {
  from: string | null | undefined
  to: string | null | undefined
  'data-testid'?: string
}

export function ShaRange({ from, to, 'data-testid': testid }: ShaRangeProps): ReactElement {
  const { t } = useTranslation()
  const a = shortSha(from)
  const b = shortSha(to)
  const dash = t('common.emDash')
  return (
    <span className="sha-range" data-testid={testid}>
      {/* Full values in `title` so a reader can copy the real sha (same idea as
          McpInventoryPanel's hash cell). */}
      <code title={from ?? undefined}>{a ?? dash}</code>
      {/* The arrow is decoration; screen readers get the labelled form below. */}
      <span aria-hidden="true"> → </span>
      <code title={to ?? undefined}>{b ?? dash}</code>
      <span className="sr-only">
        {t('common.shaRangeLabel', { from: a ?? dash, to: b ?? dash })}
      </span>
    </span>
  )
}
