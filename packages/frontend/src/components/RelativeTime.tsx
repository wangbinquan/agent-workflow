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
  // 都算一次是可测的渲染开销——惰性到指针悬停时再算(dateTime 保持即时,
  // 机器可读语义不变)。
  //
  // 存的是**已展开的那个时间戳**而不是格式化后的字符串:虚拟化列表按稳定 key
  // 复用组件实例,同一行的 ts 变化(刷新一个仓、调度任务再次触发)不会重建
  // 实例——存字符串会让 tooltip 永远停在第一次悬停时的旧时间,而相对文案已经
  // 更新,用户看不出它在骗人(实现门 P1-1)。
  const [titleFor, setTitleFor] = useState<number | null>(null)
  const ms = toEpochMs(props.ts)
  if (ms === null) return <span data-testid={props['data-testid']}>{t('common.emDash')}</span>
  const token = relativeTimeToken(now, ms)
  const label = t(`common.relTime.${token.key}`, token.opts)
  const absolute = new Date(ms).toLocaleString()
  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={titleFor === ms ? absolute : undefined}
      // 惰性化不能把绝对时间从**非悬停通道**里也拿走:<time> 不可聚焦,
      // 键盘/读屏用户悬停不了,所以绝对时间常驻 aria-label(读屏念的是它,
      // 不是可见文案),视觉用户仍走 hover tooltip。
      aria-label={`${label}（${absolute}）`}
      onMouseEnter={() => setTitleFor(ms)}
      data-testid={props['data-testid']}
    >
      {label}
    </time>
  )
}
