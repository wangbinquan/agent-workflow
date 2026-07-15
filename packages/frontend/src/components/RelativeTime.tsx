// RFC-191 (T1) — list-layer relative timestamp, single-sourced.
//
// Renders「5 分钟前」/「4 小时后」with the absolute time in the `title`
// tooltip (and a machine-readable dateTime attr — repos' existing <time>
// precedent). Detail pages keep absolute times; this component is for list
// rows and cards only (决策 D4 口径).

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNowTick } from '@/hooks/useNowTick'
import { relativeTimeToken, toEpochMs } from '@/lib/relative-time'

export interface RelativeTimeProps {
  /** Epoch ms (number) or ISO string (`CachedRepo.lastFetchedAt`). */
  ts: number | string
  'data-testid'?: string
}

export function RelativeTime(props: RelativeTimeProps): ReactElement {
  const { t } = useTranslation()
  const now = useNowTick()
  const ms = toEpochMs(props.ts)
  if (ms === null) return <span data-testid={props['data-testid']}>{t('common.emDash')}</span>
  const token = relativeTimeToken(now, ms)
  const d = new Date(ms)
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} data-testid={props['data-testid']}>
      {t(`common.relTime.${token.key}`, token.opts)}
    </time>
  )
}
