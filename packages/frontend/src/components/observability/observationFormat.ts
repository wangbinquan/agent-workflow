// RFC-371 v2 §3.4 / §6 — pure display rules of run observation: the moving
// window, token totals, and CNY / duration labels that never show an unknown
// price or an incomplete usage as an exact zero.
import type {
  ObservationCall,
  ObservationCostState,
  ObservationUsage,
} from '@agent-workflow/shared'
import { formatObservationCny } from '@agent-workflow/shared'
import { formatDurationMs } from '@/lib/duration'
import type { ObservationWindow } from './observationClient'

export const OBSERVATION_RANGES = ['24h', '7d', '30d'] as const
export type ObservationRange = (typeof OBSERVATION_RANGES)[number]

const HOUR = 3_600_000
const RANGE_MS: Record<ObservationRange, number> = {
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
}

export function isObservationRange(value: unknown): value is ObservationRange {
  return OBSERVATION_RANGES.includes(value as ObservationRange)
}

/** The window ending at the next whole minute after `anchor`, in the browser's current UTC offset. */
export function observationWindow(range: ObservationRange, anchor: number): ObservationWindow {
  const to = Math.ceil((anchor + 1) / 60_000) * 60_000
  return {
    from: to - RANGE_MS[range],
    to,
    tzOffset: -new Date(anchor).getTimezoneOffset(),
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** input + cache read + cache write + output (reasoning is part of output). */
export function tokenTotal(
  usage: Pick<ObservationUsage, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>,
): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output
}

export function formatCount(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value)
}

/** CNY of a set of calls: unpriced tokens never read as free. */
export function usageCost(usage: ObservationUsage, t: Translate): string {
  if (usage.unpricedCalls === 0) return formatObservationCny(usage.costNano)
  if (usage.costNano === 0) return t('runObservability.unpriced')
  return t('runObservability.partialCost', { cost: formatObservationCny(usage.costNano) })
}

/** CNY of one call or model row by its cost state. */
export function callCost(
  call: Pick<ObservationCall, 'costNano'> & { readonly costState: ObservationCostState },
  t: Translate,
): string {
  switch (call.costState) {
    case 'none':
      return '—'
    case 'priced':
      return formatObservationCny(call.costNano)
    case 'partial':
      return t('runObservability.partialCost', { cost: formatObservationCny(call.costNano) })
    case 'unpriced':
      return t('runObservability.unpriced')
  }
}

export function durationLabel(ms: number | null, t: Translate): string {
  if (ms === null) return '—'
  const token = formatDurationMs(ms)
  return t(`common.dur.${token.key}`, token.opts)
}

/** A known kind's product name, or the raw kind. */
export function systemKindLabel(kind: string | null, t: Translate): string {
  if (!kind) return '—'
  return t(`runObservability.kind.${kind}`, { defaultValue: kind })
}
