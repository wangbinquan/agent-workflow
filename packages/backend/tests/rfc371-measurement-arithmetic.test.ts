import { describe, expect, test } from 'bun:test'
import {
  normalizeTokenUsage,
  subtractTokenBaseline,
  summarizeTokenUsage,
  tokenCount,
} from '../src/modules/run-observability/domain/tokenUsage'
import {
  cnyPicos,
  formatCnyAmount,
  rateMicros,
  sumCnyAmounts,
  valueTokenUsage,
} from '../src/modules/run-observability/domain/cnyPricing'
import { intervalDurations } from '../src/modules/run-observability/domain/executionIntervals'

// RFC-371: resumed cumulative totals, missing counters and tiny CNY prices must not inflate or disappear.
describe('RFC-371 exact measurement arithmetic', () => {
  const usage = { input: '444', cacheRead: '7040', cacheWrite: '0', output: '3' }
  test('four exclusive buckets match the recorded OpenCode total and retain unknowns', () => {
    expect(summarizeTokenUsage([usage]).totalKnown).toBe('7487')
    const partial = normalizeTokenUsage({
      input: 0,
      cacheRead: undefined,
      cacheWrite: null,
      output: 4,
    })
    expect(partial).toEqual({ input: '0', cacheRead: null, cacheWrite: null, output: '4' })
    expect(summarizeTokenUsage([usage, partial])).toMatchObject({
      totalKnown: '7491',
      measured: 2,
      complete: 1,
      unknownBuckets: { input: 0, cacheRead: 1, cacheWrite: 1, output: 0 },
    })
    expect(summarizeTokenUsage([])).toMatchObject({ totalKnown: '0', measured: 0, complete: 0 })
  })
  test('counts stay exact past the JavaScript safe integer ceiling', () => {
    expect(
      summarizeTokenUsage([
        { ...usage, input: '9007199254740993' },
        { ...usage, input: '9007199254740993' },
      ]).known.input,
    ).toBe('18014398509481986')
    for (const invalid of [
      -1,
      1.1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '01',
      '1e3',
      '-1',
      '',
      '9'.repeat(61),
      {},
    ])
      expect(() => tokenCount(invalid)).toThrow()
  })
  test('resumed 100 → 130 attributes only 30 to the next invocation', () => {
    const baseline = { input: '100', cacheRead: '0', cacheWrite: '0', output: '0' }
    const contribution = subtractTokenBaseline({ ...baseline, input: '130' }, baseline)
    expect(contribution.input).toBe('30')
    expect(summarizeTokenUsage([baseline, contribution]).totalKnown).toBe('130')
    expect(subtractTokenBaseline({ ...baseline, input: null }, baseline).input).toBeNull()
    expect(() => subtractTokenBaseline({ ...baseline, input: '90' }, baseline)).toThrow('decreased')
  })
  test('CNY multiplication and aggregate-before-rounding remain exact', () => {
    const result = valueTokenUsage(usage, {
      input: '8',
      cacheRead: '0.8',
      cacheWrite: '10',
      output: '24',
    })
    expect(result).toEqual({
      currency: 'CNY',
      knownAmount: '0.009256',
      completeness: 'complete',
      missing: [],
    })
    const tiny = valueTokenUsage(
      { input: '1', cacheRead: '0', cacheWrite: '0', output: '0' },
      { input: '0.000001', cacheRead: null, cacheWrite: null, output: null },
    )
    expect(tiny.knownAmount).toBe('0.000000000001')
    expect(formatCnyAmount(tiny.knownAmount)).toBe('<¥0.000001')
    expect(sumCnyAmounts(['0.0000005', '0.0000005'])).toBe('0.000001')
    expect(formatCnyAmount('1234.1234565')).toBe('¥1234.123457')
    expect(formatCnyAmount('0')).toBe('¥0')
    expect(cnyPicos('1.000000000001')).toBe(1000000000001n)
  })
  test('explicit free, unavailable price and unknown usage are different', () => {
    const rates = { input: '0', cacheRead: null, cacheWrite: null, output: '1' }
    expect(valueTokenUsage(usage, rates)).toMatchObject({
      knownAmount: '0.000003',
      completeness: 'partial',
      missing: ['cacheRead'],
    })
    expect(
      valueTokenUsage({ input: null, cacheRead: null, cacheWrite: null, output: null }, rates)
        .completeness,
    ).toBe('unpriced')
    expect(rateMicros(null)).toBeNull()
    for (const invalid of ['-1', '1e3', '0.0000001', ' 1', '.1', '01', 'Infinity'])
      expect(() => rateMicros(invalid)).toThrow()
    expect(() => cnyPicos('0.0000000000001')).toThrow()
  })
  test('overlapping attempts have cumulative occupancy above the activity union', () => {
    expect(
      intervalDurations(
        [
          { start: 10, end: 30 },
          { start: 20, end: 40 },
          { start: 25, end: 26 },
          { start: 60, end: null },
        ],
        { from: 0, to: 100, asOf: 80 },
      ),
    ).toEqual({ cumulativeMs: 61, activeUnionMs: 50 })
    expect(intervalDurations([{ start: 10, end: 40 }], { from: 20, to: 30, asOf: 100 })).toEqual({
      cumulativeMs: 10,
      activeUnionMs: 10,
    })
    expect(
      intervalDurations([{ start: 100, end: null }], { from: 0, to: 90, asOf: 80 }).cumulativeMs,
    ).toBe(0)
    expect(() => intervalDurations([{ start: 2, end: 1 }], { from: 0, to: 10, asOf: 10 })).toThrow()
    expect(() => intervalDurations([], { from: 10, to: 0, asOf: 10 })).toThrow()
  })
})
