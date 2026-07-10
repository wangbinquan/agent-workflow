// RFC-159 — pure helpers for the scheduled-task UI (preview + summary).
// Reuses the shared scheduleTime engine so the "next 3 fires" preview matches
// exactly what the daemon will do.
import type { ScheduleSpec } from '@agent-workflow/shared'
import { computeNextRunAt } from '@agent-workflow/shared'

/** The next `count` fire instants strictly after `from` (epoch ms). */
export function nextRuns(spec: ScheduleSpec, from: number, count: number): number[] {
  const out: number[] = []
  let anchor = from
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAt(spec, anchor, anchor)
    out.push(next)
    anchor = next
  }
  return out
}

const DOW_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_LABELS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * A compact human summary of a schedule. `lang` picks the label set; the numeric
 * pieces (interval N, HH:MM, day-of-month) are language-neutral.
 */
export function scheduleSummary(spec: ScheduleSpec | null, lang: 'en' | 'zh'): string {
  // RFC-165: degraded/legacy rows carry a null spec — render a neutral dash;
  // the detail page surfaces the repair affordance.
  if (spec === null) return '—'
  const zh = lang === 'zh'
  if (spec.kind === 'interval') {
    const unit = zh
      ? { minutes: '分钟', hours: '小时', days: '天' }[spec.unit]
      : `${spec.unit}${spec.every === 1 ? '' : ''}`
    return zh ? `每隔 ${spec.every} ${unit}` : `every ${spec.every} ${spec.unit}`
  }
  const tzNote = zh ? `（${spec.timezone}）` : ` (${spec.timezone})`
  if (spec.kind === 'daily') return (zh ? `每天 ${spec.at}` : `daily at ${spec.at}`) + tzNote
  if (spec.kind === 'weekly') {
    const labels = zh ? DOW_LABELS_ZH : DOW_LABELS_EN
    const days = spec.daysOfWeek.map((d) => labels[d]).join(zh ? '、' : ', ')
    return (zh ? `每周 ${days} ${spec.at}` : `weekly on ${days} at ${spec.at}`) + tzNote
  }
  return (
    (zh
      ? `每月 ${spec.dayOfMonth} 号 ${spec.at}`
      : `monthly on day ${spec.dayOfMonth} at ${spec.at}`) + tzNote
  )
}
