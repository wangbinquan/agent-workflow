// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §3.3–§6):
// the pure display and input rules of run observation — the moving window, CNY
// labels that never show an unknown price as free, readable durations, URL search
// defaults, and price drafts (empty rate is unknown, past effective time refused,
// the compare-and-set base passed through).
import { beforeEach, describe, expect, test } from 'vitest'
import type { ObservationUsage } from '@agent-workflow/shared'
import {
  callCost,
  durationLabel,
  observationWindow,
  systemKindLabel,
  tokenTotal,
  usageCost,
} from '../src/components/observability/observationFormat'
import { initialPriceDraft, preparePrice } from '../src/components/observability/priceDraft'
import { validateObservationSearch } from '../src/routes/observability'
import i18n from '../src/i18n'

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)

function usage(overrides: Partial<ObservationUsage> = {}): ObservationUsage {
  return {
    calls: 1,
    incompleteCalls: 0,
    failedCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costNano: 0,
    unpricedCalls: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('RFC-371 v2 observation display rules', () => {
  test('the window ends at the next whole minute and carries the browser offset', () => {
    const anchor = Date.UTC(2026, 9, 14, 8, 30, 15)
    const window = observationWindow('7d', anchor)
    expect(window.to).toBe(Date.UTC(2026, 9, 14, 8, 31))
    expect(window.to - window.from).toBe(7 * 86_400_000)
    expect(window.tzOffset).toBe(-new Date(anchor).getTimezoneOffset())
    // Exactly on a minute boundary still includes calls started at the anchor.
    expect(observationWindow('24h', Date.UTC(2026, 9, 14, 8, 30)).to).toBe(
      Date.UTC(2026, 9, 14, 8, 31),
    )
  })

  test('tokens add the four buckets; reasoning is already inside output', () => {
    expect(
      tokenTotal(usage({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 4 })),
    ).toBe(10)
  })

  test('an unknown price is never shown as free', () => {
    expect(usageCost(usage({ costNano: 2_000_000_000 }), t)).toBe('¥2.00')
    expect(usageCost(usage({ costNano: 0 }), t)).toBe('¥0.00')
    expect(usageCost(usage({ costNano: 0, unpricedCalls: 1 }), t)).toBe('未定价')
    expect(usageCost(usage({ costNano: 1_500_000_000, unpricedCalls: 1 }), t)).toBe('¥1.50 起')
    expect(usageCost(usage({ costNano: 999 }), t)).toBe('< ¥0.000001')
    expect(callCost({ costNano: 0, costState: 'none' }, t)).toBe('—')
    expect(callCost({ costNano: 8_000, costState: 'priced' }, t)).toBe('¥0.000008')
    expect(callCost({ costNano: 8_000, costState: 'partial' }, t)).toBe('¥0.000008 起')
    expect(callCost({ costNano: 0, costState: 'unpriced' }, t)).toBe('未定价')
  })

  test('durations are readable and unknown durations are a dash', () => {
    expect(durationLabel(null, t)).toBe('—')
    expect(durationLabel(12_000, t)).toBe('12 秒')
    expect(durationLabel(3 * 60_000 + 12_000, t)).toBe('3 分钟')
    expect(durationLabel(2 * 3_600_000 + 5 * 60_000, t)).toBe('2 小时 5 分')
  })

  test('system kinds use product names and fall back to the raw kind', () => {
    expect(systemKindLabel('merge-resolve', t)).toBe('合并冲突处理')
    expect(systemKindLabel('memory-distill', t)).toBe('记忆提取')
    expect(systemKindLabel('future-kind', t)).toBe('future-kind')
    expect(systemKindLabel(null, t)).toBe('—')
  })

  test('URL search falls back to the 7-day overview and keeps only valid fields', () => {
    expect(validateObservationSearch({})).toEqual({ range: '7d', tab: 'overview' })
    expect(
      validateObservationSearch({
        range: '30d',
        tab: 'tasks',
        task: 't-1',
        q: 'deploy',
        status: 'failed',
        kind: 'merge-resolve',
      }),
    ).toEqual({
      range: '30d',
      tab: 'tasks',
      task: 't-1',
      q: 'deploy',
      status: 'failed',
      kind: 'merge-resolve',
    })
    expect(
      validateObservationSearch({ range: '1y', tab: 'storage', status: 'nope', q: '  ', task: 7 }),
    ).toEqual({ range: '7d', tab: 'overview' })
  })
})

describe('RFC-371 v2 price drafts', () => {
  const now = Date.UTC(2026, 9, 14, 8, 0)

  test('a draft starts from the current version, or empty (unknown) rates', () => {
    expect(initialPriceDraft('sonnet', null)).toMatchObject({
      model: 'sonnet',
      input: '',
      output: '',
    })
    expect(
      initialPriceDraft('sonnet', {
        id: 'p1',
        runtimeId: 'rt',
        model: 'sonnet',
        rates: { input: '3', cacheRead: '0.3', cacheWrite: null, output: '15' },
        effectiveFrom: 0,
        createdAt: 0,
        createdBy: 'admin',
        note: '',
      }),
    ).toMatchObject({ input: '3', cacheRead: '0.3', cacheWrite: '', output: '15' })
  })

  test('empty rates are unknown, saves apply on save and carry the compare-and-set base', () => {
    const prepared = preparePrice(
      { ...initialPriceDraft(' sonnet ', null), input: ' 3 ', output: '15.5', note: ' list ' },
      'p-latest',
      now,
    )
    expect(prepared.errors).toEqual({})
    expect(prepared.input).toEqual({
      model: 'sonnet',
      rates: { input: '3', cacheRead: null, cacheWrite: null, output: '15.5' },
      effectiveFrom: now,
      note: 'list',
      expectedLatestId: 'p-latest',
    })
  })

  test('invalid model, rates and past effective times are refused before any request', () => {
    const prepared = preparePrice(
      {
        ...initialPriceDraft('', null),
        input: '-1',
        cacheRead: '1.1234567',
        cacheWrite: '01',
        output: 'abc',
        effectiveFrom: '2000-01-01T00:00',
      },
      null,
      now,
    )
    expect(prepared.input).toBeUndefined()
    expect(prepared.errors).toEqual({
      model: 'observationPricing.invalidModel',
      input: 'observationPricing.invalidRate',
      cacheRead: 'observationPricing.invalidRate',
      cacheWrite: 'observationPricing.invalidRate',
      output: 'observationPricing.invalidRate',
      effectiveFrom: 'observationPricing.invalidEffectiveFrom',
    })
  })

  test('a future effective time is kept', () => {
    const future = new Date(now + 3_600_000)
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(
      future.getDate(),
    ).padStart(2, '0')}T${String(future.getHours()).padStart(2, '0')}:${String(
      future.getMinutes(),
    ).padStart(2, '0')}`
    const prepared = preparePrice(
      { ...initialPriceDraft('sonnet', null), input: '0', effectiveFrom: local },
      null,
      now,
    )
    expect(prepared.input?.effectiveFrom).toBe(now + 3_600_000)
    expect(prepared.input?.rates.input).toBe('0')
  })
})
