// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §3–§5):
// the pure rules every statistic relies on — usage snapshots (unknown is never
// zero, reasoning is a subset of output), integer CNY costing, the price-version
// selection that freezes a call's price without a snapshot table, and the
// percentile / continuous-day helpers.
import { describe, expect, test } from 'bun:test'
import {
  formatObservationCny,
  observationMicroToRate,
  observationRateToMicro,
} from '@agent-workflow/shared'
import {
  normalizeObservedUsage,
  sumBuckets,
  totalTokens,
  usageStateOf,
} from '@/modules/run-observability/domain/usage'
import {
  callCostState,
  modelCost,
  selectPrice,
  type PriceVersion,
} from '@/modules/run-observability/domain/pricing'
import {
  chunks,
  dayIndex,
  dayIndexes,
  dayLabel,
  nearestRank,
} from '@/modules/run-observability/domain/statistics'

const usage = (
  model: string,
  input = 0,
  output = 0,
  extra: Partial<Record<string, number>> = {},
) => ({
  model,
  input,
  cacheRead: extra.cacheRead ?? 0,
  cacheWrite: extra.cacheWrite ?? 0,
  output,
  reasoning: extra.reasoning ?? 0,
})

function price(overrides: Partial<PriceVersion> = {}): PriceVersion {
  return {
    id: 'p1',
    runtimeId: 'rt',
    model: 'm',
    inputMicro: 2_000_000,
    cacheReadMicro: 500_000,
    cacheWriteMicro: 3_000_000,
    outputMicro: 8_000_000,
    effectiveFrom: 100,
    createdAt: 100,
    createdBy: 'admin',
    note: '',
    ...overrides,
  }
}

describe('RFC-371 v2 usage snapshots', () => {
  test('duplicate models merge, invalid counts drop and reasoning never exceeds output', () => {
    const merged = normalizeObservedUsage({
      state: 'partial',
      models: [
        usage(' m ', 10, 4, { reasoning: 9 }),
        usage('m', 5, 1, { cacheRead: -3 }),
        usage('', Number.NaN, 2.5),
      ],
    })
    expect(merged.models).toEqual([
      usage('', 0, 0),
      { model: 'm', input: 15, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 4 },
    ])
    expect(sumBuckets(merged.models)).toMatchObject({ input: 15, output: 5, reasoning: 4 })
    expect(totalTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 4 })).toBe(10)
  })

  test('an empty partial snapshot is pending while running and unreported once ended', () => {
    expect(usageStateOf(null, false)).toBe('pending')
    expect(usageStateOf(null, true)).toBe('none')
    expect(usageStateOf({ state: 'partial', models: [] }, false)).toBe('pending')
    expect(usageStateOf({ state: 'partial', models: [] }, true)).toBe('none')
    expect(usageStateOf({ state: 'partial', models: [usage('m', 1)] }, true)).toBe('partial')
    // A proven complete zero (e.g. a native summary with no steps) stays complete.
    expect(usageStateOf({ state: 'complete', models: [] }, true)).toBe('complete')
  })
})

describe('RFC-371 v2 pricing', () => {
  test('a version applies only when effective and already created when the call started', () => {
    const v1 = price({ id: 'a', effectiveFrom: 100, createdAt: 100 })
    const v2 = price({ id: 'b', effectiveFrom: 200, createdAt: 150 })
    // Back-dated: effective from 50 but saved at 300 — never reprices earlier calls.
    const backdated = price({ id: 'c', effectiveFrom: 50, createdAt: 300 })
    expect(selectPrice([v1, v2, backdated], 99)).toBeNull()
    expect(selectPrice([v1, v2, backdated], 120)?.id).toBe('a')
    expect(selectPrice([v1, v2, backdated], 250)?.id).toBe('b')
    expect(selectPrice([v1, v2, backdated], 400)?.id).toBe('b')
    const later = price({ id: 'd', effectiveFrom: 200, createdAt: 160 })
    expect(selectPrice([v2, later], 400)?.id).toBe('d')
  })

  test('costs are exact integer nano-yuan, rounded half up', () => {
    // 1,000,000 input × ¥2/M = ¥2 = 2e9 nano-yuan.
    expect(modelCost(usage('m', 1_000_000), price())).toEqual({
      costNano: 2_000_000_000,
      complete: true,
    })
    // 1 output token × ¥8/M = ¥0.000008 = 8000 nano-yuan.
    expect(modelCost(usage('m', 0, 1), price()).costNano).toBe(8_000)
    // 1 token at ¥0.0000005/M: 0.5 nano-yuan rounds half up.
    expect(modelCost(usage('m', 1), price({ inputMicro: 500 })).costNano).toBe(1)
    // Intermediate products beyond 2^53 stay exact in BigInt.
    expect(
      modelCost(usage('m', 3_000_000_001), price({ inputMicro: 9_007_199_253 })).costNano,
    ).toBe(Number((3_000_000_001n * 9_007_199_253n + 500n) / 1000n))
  })

  test('an unknown rate is never free: partial or unpriced, never zero cost', () => {
    const partial = modelCost(usage('m', 10, 10), price({ outputMicro: null }))
    expect(partial).toEqual({ costNano: 20_000, complete: false })
    expect(modelCost(usage('m', 10), price({ inputMicro: null }))).toEqual({
      costNano: null,
      complete: false,
    })
    expect(modelCost(usage('m', 10), null)).toEqual({ costNano: null, complete: false })
    // No tokens in the unknown bucket keeps a complete price.
    expect(modelCost(usage('m', 10), price({ outputMicro: null }))).toEqual({
      costNano: 20_000,
      complete: true,
    })
  })

  test('a call is priced, partial, unpriced or has no tokens at all', () => {
    const priced = { costNano: 5, complete: true }
    const missing = { costNano: null, complete: false }
    const some = { costNano: 3, complete: false }
    expect(callCostState([])).toEqual({ costNano: 0, costState: 'none' })
    expect(callCostState([{ tokens: 0, cost: missing }])).toEqual({
      costNano: 0,
      costState: 'none',
    })
    expect(callCostState([{ tokens: 1, cost: priced }])).toEqual({
      costNano: 5,
      costState: 'priced',
    })
    expect(callCostState([{ tokens: 1, cost: missing }])).toEqual({
      costNano: 0,
      costState: 'unpriced',
    })
    expect(
      callCostState([
        { tokens: 1, cost: priced },
        { tokens: 1, cost: missing },
      ]),
    ).toEqual({ costNano: 5, costState: 'partial' })
    expect(callCostState([{ tokens: 1, cost: some }])).toEqual({
      costNano: 3,
      costState: 'partial',
    })
  })

  test('decimal rates round-trip through integer micro-yuan', () => {
    expect(observationRateToMicro('2.5')).toBe(2_500_000)
    expect(observationRateToMicro('0')).toBe(0)
    expect(observationRateToMicro('0.000001')).toBe(1)
    expect(observationRateToMicro('123456789.123456')).toBe(123_456_789_123_456)
    expect(() => observationRateToMicro('1234567890')).toThrow('invalid-rate')
    expect(() => observationRateToMicro('1.0000001')).toThrow('invalid-rate')
    expect(() => observationRateToMicro('-1')).toThrow('invalid-rate')
    expect(observationMicroToRate(2_500_000)).toBe('2.5')
    expect(observationMicroToRate(0)).toBe('0')
    expect(observationMicroToRate(1)).toBe('0.000001')
  })

  test('CNY display keeps six decimals and never shows a tiny amount as free', () => {
    expect(formatObservationCny(0)).toBe('¥0.00')
    expect(formatObservationCny(999)).toBe('< ¥0.000001')
    expect(formatObservationCny(1000)).toBe('¥0.000001')
    expect(formatObservationCny(2_000_000_000)).toBe('¥2.00')
    expect(formatObservationCny(1_234_567_890_000)).toBe('¥1,234.56789')
  })
})

describe('RFC-371 v2 statistics', () => {
  test('nearest-rank percentiles over the raw sample', () => {
    expect(nearestRank([], 0.5)).toBeNull()
    expect(nearestRank([7], 0.95)).toBe(7)
    const sample = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(nearestRank(sample, 0.5)).toBe(10)
    expect(nearestRank(sample, 0.95)).toBe(19)
    expect(nearestRank(sample, 1)).toBe(20)
  })

  test('daily buckets are continuous at the requested offset', () => {
    const day = 86_400_000
    const from = Date.UTC(2026, 9, 1, 0, 0) // 2026-10-01T00:00Z
    // UTC+8: 2026-10-01T00:00Z is 08:00 local on Oct 1; the 3-day window ends on Oct 4 local.
    const days = dayIndexes(from, from + 3 * day, 480)
    expect(days.map(dayLabel)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(dayLabel(dayIndex(Date.UTC(2026, 9, 1, 17, 0), 480))).toBe('2026-10-02')
    expect(dayIndexes(from, from + day, 0).map(dayLabel)).toEqual(['2026-10-01'])
  })

  test('id batches split at the requested size', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks([], 500)).toEqual([])
  })
})
