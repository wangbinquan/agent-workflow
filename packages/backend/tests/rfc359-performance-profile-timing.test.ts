// RFC-359 AC11: preserve the diagnostic request's wall-clock interval, excluding
// EXPLAIN and corpus checks. This does not map the CPU profiler's separate clock.
import { expect, test } from 'bun:test'
import { PERF_HTTP_SCENARIOS } from '../../../scripts/perf-compare'
import { createQueryCapture, profilePerformanceQueries } from '../../../scripts/perf-query-profile'

test('diagnostic capture preserves its monotonic interval and Unix clock origin', async () => {
  const capture = createQueryCapture()
  const value = { marker: 'actual operation result' }
  const before = performance.now()
  let operationTime = 0
  const result = await capture.capture(async () => {
    operationTime = performance.now()
    capture.start('SELECT 1', [])(1)
    return value
  })
  const after = performance.now()

  expect(result.value).toBe(value)
  expect(result.timing.timeOriginUnixMs).toBe(performance.timeOrigin)
  expect(Number.isFinite(result.timing.timeOriginUnixMs)).toBe(true)
  expect(result.timing.startTimeMs).toBeGreaterThanOrEqual(before)
  expect(result.timing.startTimeMs).toBeLessThanOrEqual(operationTime)
  expect(result.timing.endTimeMs).toBeGreaterThanOrEqual(operationTime)
  expect(result.timing.endTimeMs).toBeLessThanOrEqual(after)
  expect(result.wallMs).toBe(result.timing.endTimeMs - result.timing.startTimeMs)
  expect(result.statements).toHaveLength(1)
})

test('each diagnostic endpoint keeps EXPLAIN outside its request interval', async () => {
  const capture = createQueryCapture()
  const requests: number[] = []
  const explains: number[] = []
  const report = {
    complete: true,
    sourceSha: 'a'.repeat(40),
    executionId: 'profile-timing-unit',
    provider: 'sqlite' as const,
    tier: 'small' as const,
    scenarios: PERF_HTTP_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      legacyPath: scenario.legacyPath,
      path: scenario.path,
      samples: [1],
      p50: 1,
      p95: 1,
      max: 1,
      witness: {
        status: 200,
        schemaVersion: null,
        itemIds: [],
        nextCursor: null,
        responseDigest: 'unit',
      },
    })),
  }
  const originalReport = JSON.stringify(report)
  const result = await profilePerformanceQueries({
    capture,
    report,
    token: 'unit',
    app: {
      request() {
        requests.push(performance.now())
        capture.start('SELECT 1', [])(1)
        return new Response('ok')
      },
    },
    explain: async () => {
      explains.push(performance.now())
      return [{ detail: 'SCAN CONSTANT ROW' }]
    },
  })

  expect(result.complete).toBe(true)
  expect(result.results).toHaveLength(PERF_HTTP_SCENARIOS.length)
  expect(JSON.stringify(report)).toBe(originalReport)
  for (const [index, item] of result.results.entries()) {
    expect(item.timing.startTimeMs).toBeLessThanOrEqual(requests[index]!)
    expect(item.timing.endTimeMs).toBeGreaterThanOrEqual(requests[index]!)
    expect(item.timing.endTimeMs).toBeLessThanOrEqual(explains[index]!)
    expect(item.wallMs).toBe(item.timing.endTimeMs - item.timing.startTimeMs)
    if (index > 0) expect(item.timing.startTimeMs).toBeGreaterThanOrEqual(explains[index - 1]!)
  }
})
