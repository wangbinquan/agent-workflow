// RFC-371: diagnostic failures must not fail an otherwise complete original report.
import { expect, test } from 'bun:test'
import {
  completeReportPerformanceObserver,
  type CompleteReportPerformanceSample,
} from '@/modules/run-observability/infrastructure/completeReportPerformanceObserver'

test('ordinary report keys never access a diagnostic clock or logger', () => {
  expect(
    completeReportPerformanceObserver('ordinary-report', 'normal-refresh-key', {
      now: () => {
        throw new Error('Clock must remain unused')
      },
      emit: () => {
        throw new Error('Logger must remain unused')
      },
    }),
  ).toBeUndefined()
})

test('diagnostic records preserve report identity and separate cumulative from segment time', () => {
  const times = [100, 117, 190],
    records: CompleteReportPerformanceSample[] = []
  const observer = completeReportPerformanceObserver('fixed-report', 'load-performance-check', {
    now: () => times.shift()!,
    emit: (sample) => records.push(sample),
  })
  expect(observer).toBeTypeOf('function')
  observer!('actor-qualified')
  observer!('native-collected')
  expect(records).toEqual([
    { reportId: 'fixed-report', phase: 'actor-qualified', elapsedMs: 17, phaseMs: 17 },
    { reportId: 'fixed-report', phase: 'native-collected', elapsedMs: 90, phaseMs: 73 },
  ])
})

test('clock initialization and later clock or logger failures never escape diagnostics', () => {
  expect(
    completeReportPerformanceObserver('clock-error', 'load-performance-check', {
      now: () => {
        throw new Error('Clock unavailable')
      },
    }),
  ).toBeUndefined()
  const times = [0, 10, new Error('Clock failed'), 20, 30],
    records: CompleteReportPerformanceSample[] = []
  let writes = 0
  const observer = completeReportPerformanceObserver('original-report', 'load-performance-check', {
    now: () => {
      const value = times.shift()!
      if (value instanceof Error) throw value
      return value
    },
    emit: (sample) => {
      writes++
      if (writes === 1) throw new Error('Logger failed')
      records.push(sample)
    },
  })
  expect(() => observer!('actor-qualified')).not.toThrow()
  expect(() => observer!('owners-events-collected')).not.toThrow()
  expect(() => observer!('native-collected')).not.toThrow()
  expect(() => observer!('transfer-sealed')).not.toThrow()
  expect(records).toEqual([
    { reportId: 'original-report', phase: 'native-collected', elapsedMs: 20, phaseMs: 10 },
    { reportId: 'original-report', phase: 'transfer-sealed', elapsedMs: 30, phaseMs: 10 },
  ])
})

test('nonfinite or backward clock samples are discarded without changing report work', () => {
  const times = [5, Number.NaN, 4, 15],
    records: CompleteReportPerformanceSample[] = []
  const observer = completeReportPerformanceObserver('original-report', 'load-performance-check', {
    now: () => times.shift()!,
    emit: (sample) => records.push(sample),
  })
  expect(() => observer!('invalid-clock')).not.toThrow()
  expect(() => observer!('backward-clock')).not.toThrow()
  expect(() => observer!('transfer-sealed')).not.toThrow()
  expect(records).toEqual([
    { reportId: 'original-report', phase: 'transfer-sealed', elapsedMs: 10, phaseMs: 10 },
  ])
  expect(
    completeReportPerformanceObserver('invalid-clock', 'load-performance-check', {
      now: () => Number.NaN,
    }),
  ).toBeUndefined()
})
