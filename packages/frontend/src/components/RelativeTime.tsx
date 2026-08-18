// RFC-191 (T1) — list-layer relative timestamp, single-sourced.
//
// Renders「5 分钟前」/「4 小时后」with the absolute time in the `title`
// tooltip (and a machine-readable dateTime attr — repos' existing <time>
// precedent). Detail pages keep absolute times; this component is for list
// rows and cards only (决策 D4 口径).

import { useState, type ReactElement } from 'react'
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
  // RFC-311(T26):tooltip 的 toLocaleString 是 Intl 调用,长列表每行每 tick
  // 都算一次是可测的渲染开销——惰性到指针悬停/聚焦时再算(hover 前 title
  // 缺省;dateTime 保持即时,机器可读语义不变)。
  const [title, setTitle] = useState<string | undefined>(undefined)
  const ms = toEpochMs(props.ts)
  if (ms === null) return <span data-testid={props['data-testid']}>{t('common.emDash')}</span>
  const token = relativeTimeToken(now, ms)
  const computeTitle = (): void => setTitle(new Date(ms).toLocaleString())
  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={title}
      onMouseEnter={computeTitle}
      onFocus={computeTitle}
      data-testid={props['data-testid']}
    >
      {t(`common.relTime.${token.key}`, token.opts)}
    </time>
  )
}
