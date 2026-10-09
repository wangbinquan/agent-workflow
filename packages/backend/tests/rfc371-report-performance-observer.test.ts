// RFC-371: diagnostic failures must not fail an otherwise complete original report.
import { expect, test } from 'bun:test'
import {
  completeReportPerformanceObserver,
  completeReportOperationObserver,
  measureCompleteReportSources,
  type CompleteReportPerformanceSample,
  type CompleteReportOperationSample,
} from '@/modules/run-observability/infrastructure/completeReportPerformanceObserver'
import type { CompleteWorkingRows } from '@/modules/run-observability/ports/completeWorkingRows'
import type { HistoricalObservationSources } from '@/modules/run-observability/ports/historicalObservationSources'

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

test('operation diagnostics are opt-in and preserve exact sync/async results and total call counts', async () => {
  expect(
    completeReportOperationObserver('ordinary', 'ordinary-key', {
      now: () => {
        throw new Error('Clock must not be used')
      },
    }),
  ).toBeUndefined()
  const times = [10, 13, 20, 27, 30, 35],
    samples: CompleteReportOperationSample[] = [],
    value = { original: true }
  const observer = completeReportOperationObserver('report', 'load-performance-operations', {
    now: () => times.shift()!,
    emit: (sample) => samples.push(sample),
  })!
  let calls = 0
  expect(
    observer.measureSync('native.next', () => {
      calls++
      return value
    }),
  ).toBe(value)
  expect(
    await observer.measure('workspace.get', async () => {
      calls++
      return value
    }),
  ).toBe(value)
  expect(observer.measureSync('native.next', () => value)).toBe(value)
  observer.flush()
  observer.flush()
  expect(calls).toBe(2)
  expect(samples).toEqual([
    { reportId: 'report', operation: 'native.next', calls: '2', timedCalls: '2', totalMs: 8 },
    { reportId: 'report', operation: 'workspace.get', calls: '1', timedCalls: '1', totalMs: 7 },
  ])
})

test('operation timing preserves original undefined throws and numeric rejections through logger failure', async () => {
  let time = 0,
    calls = 0,
    caught = false
  const samples: CompleteReportOperationSample[] = []
  const observer = completeReportOperationObserver('report', 'load-performance-errors', {
    now: () => ++time,
    emit: (sample) => {
      samples.push(sample)
      throw new Error('Diagnostic output failed')
    },
  })!
  try {
    observer.measureSync('native.next', () => {
      calls++
      throw undefined
    })
  } catch (error) {
    caught = true
    expect(error).toBeUndefined()
  }
  await expect(
    observer.measure('workspace.get', async () => {
      calls++
      throw 0
    }),
  ).rejects.toBe(0)
  expect(caught).toBe(true)
  expect(calls).toBe(2)
  expect(() => observer.flush()).not.toThrow()
  expect(samples.map((sample) => [sample.operation, sample.calls, sample.totalMs])).toEqual([
    ['native.next', '1', 1],
    ['workspace.get', '1', 1],
  ])
})

test('broken or backward operation clocks retain all calls and never claim a complete duration', async () => {
  const times = [new Error('Clock failed'), 10, 20, 19, Number.NaN, 30],
    samples: CompleteReportOperationSample[] = []
  const observer = completeReportOperationObserver('report', 'load-performance-clocks', {
    now: () => {
      const value = times.shift()!
      if (value instanceof Error) throw value
      return value
    },
    emit: (sample) => samples.push(sample),
  })!
  let calls = 0
  for (let index = 0; index < 3; index++)
    expect(
      await observer.measure('workspace.get', async () => {
        calls++
        return index
      }),
    ).toBe(index)
  observer.flush()
  expect(calls).toBe(3)
  expect(samples).toEqual([
    { reportId: 'report', operation: 'workspace.get', calls: '3', timedCalls: '0', totalMs: null },
  ])
})

test('source wrappers retain original workspace receivers, parameters, Maps, and native synchronous ACK', async () => {
  const calls: unknown[][] = [],
    value = { original: true },
    found = new Map([['key', value]]),
    result = { items: [{ key: 'key', document: value }], nextCursor: 'next' },
    samples: CompleteReportOperationSample[] = []
  const rows: CompleteWorkingRows = {
    async insert(...args) {
      expect(this).toBe(rows)
      calls.push(['insert', ...args])
    },
    async put(...args) {
      expect(this).toBe(rows)
      calls.push(['put', ...args])
    },
    async upsert(...args) {
      expect(this).toBe(rows)
      calls.push(['upsert', ...args])
    },
    async get<T>(...args: [string, string]) {
      expect(this).toBe(rows)
      calls.push(['get', ...args])
      return value as T
    },
    async getMany<T>(...args: [string, readonly string[]]) {
      expect(this).toBe(rows)
      calls.push(['getMany', ...args])
      return found as unknown as ReadonlyMap<string, T>
    },
    async page<T>(...args: [string, string | null, number?]) {
      expect(this).toBe(rows)
      calls.push(['page', ...args])
      return result as { items: { key: string; document: T }[]; nextCursor: string | null }
    },
    async clear(...args) {
      expect(this).toBe(rows)
      calls.push(['clear', ...args])
    },
  }
  const original = { key: 'key', document: value },
    observer = completeReportOperationObserver('report', 'load-performance-wrappers', {
      now: () => 1,
      emit: (sample) => samples.push(sample),
    })!
  const measured = measureCompleteReportSources(observer, rows, undefined)
  expect(measured.historical).toBeUndefined()
  await measured.rows.insert('namespace', [original])
  await measured.rows.put('namespace', original)
  await measured.rows.upsert('namespace', [original])
  expect(await measured.rows.get<typeof value>('namespace', 'key')).toBe(value)
  expect(await measured.rows.getMany('namespace', ['key'])).toBe(found)
  expect(await measured.rows.page('namespace', 'after', 137)).toBe(result)
  expect(await measured.rows.page('namespace', null)).toBe(result)
  await measured.rows.clear('namespace')
  expect(calls).toEqual([
    ['insert', 'namespace', [original]],
    ['put', 'namespace', original],
    ['upsert', 'namespace', [original]],
    ['get', 'namespace', 'key'],
    ['getMany', 'namespace', ['key']],
    ['page', 'namespace', 'after', 137],
    ['page', 'namespace', null],
    ['clear', 'namespace'],
  ])
  const nativeFailure = { originalFailure: true }
  let acknowledgements = 0,
    closed = 0,
    nativeReads = 0
  const historical: HistoricalObservationSources = {
    owners: [],
    task: async () => null,
    native: {
      async open(input) {
        expect(this).toBe(historical.native)
        if (input.rootSessionId === 'missing') return null
        return {
          identity: {
            kind: 'historical-observed',
            referenceId: input.referenceId,
            passId: 'pass',
            nativeSource: 'source',
            sourceGeneration: 'generation',
            rootSessionId: input.rootSessionId,
          },
          rootCreatedAt: 0,
          initialCursor: 'cursor',
          next(cursor) {
            nativeReads++
            expect(cursor).toBe('cursor')
            throw nativeFailure
          },
          acknowledge(ordinal, digest) {
            expect([ordinal, digest]).toEqual(['0', 'digest'])
            acknowledgements++
          },
          close() {
            closed++
          },
        }
      },
      async generation() {
        expect(this).toBe(historical.native)
        return 'generation'
      },
    },
  }
  const query = measureCompleteReportSources(observer, rows, historical).historical!
  expect(query.task).toBe(historical.task)
  expect(query.owners).toBe(historical.owners)
  expect(await query.native.open({ referenceId: 'reference', rootSessionId: 'missing' })).toBeNull()
  const reader = (await query.native.open({ referenceId: 'reference', rootSessionId: 'root' }))!
  expect(reader.initialCursor).toBe('cursor')
  let caughtNativeFailure = false
  try {
    reader.next('cursor')
  } catch (error) {
    caughtNativeFailure = true
    expect(error).toBe(nativeFailure)
  }
  expect(caughtNativeFailure).toBe(true)
  expect(nativeReads).toBe(1)
  expect(reader.acknowledge('0', 'digest')).toBeUndefined()
  expect(acknowledgements).toBe(1)
  expect(reader.close()).toBeUndefined()
  expect(closed).toBe(1)
  expect(await query.native.generation()).toBe('generation')
  observer.flush()
  expect(samples.map((sample) => [sample.operation, sample.calls, sample.totalMs])).toEqual([
    ['workspace.insert', '1', 0],
    ['workspace.put', '1', 0],
    ['workspace.upsert', '1', 0],
    ['workspace.get', '1', 0],
    ['workspace.getMany', '1', 0],
    ['workspace.page', '2', 0],
    ['workspace.clear', '1', 0],
    ['native.open', '2', 0],
    ['native.next', '1', 0],
    ['native.acknowledge', '1', 0],
    ['native.close', '1', 0],
    ['native.generation', '1', 0],
  ])
})
