// RFC-359 AC11: process-wide CPU timestamps did not line up with diagnostic
// request intervals. Exercise the real Bun sampler on controlled async work;
// these requests do not open a database, listen on a port or supply P95 samples.
import { expect, test } from 'bun:test'
import { PERF_HTTP_SCENARIOS } from '../../../scripts/perf-compare'
import {
  captureRequestCpu,
  createQueryCapture,
  profilePerformanceQueries,
} from '../../../scripts/perf-query-profile'

test('request CPU sampling awaits the original operation and preserves its value', async () => {
  const value = { marker: 'request result' }
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let finished = false
  const pending = captureRequestCpu(async () => {
    await ready
    finished = true
    return value
  })
  expect(finished).toBe(false)
  release()
  const observed = await pending
  expect(finished).toBe(true)
  expect(observed.value).toBe(value)
  expect(typeof observed.cpuProfile.functions).toBe('string')
  expect(typeof observed.cpuProfile.bytecodes).toBe('string')
})

test('request CPU sampling preserves an asynchronous failure and can profile again', async () => {
  const failure = new Error('original request failed')
  let caught: unknown
  try {
    await captureRequestCpu(async () => {
      await Promise.resolve()
      throw failure
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  const next = await captureRequestCpu(async () => undefined)
  expect(next.value).toBeUndefined()
  expect(typeof next.cpuProfile.functions).toBe('string')
})

test('each diagnostic endpoint returns its own CPU profile before EXPLAIN', async () => {
  const capture = createQueryCapture()
  const requests: string[] = []
  const report = {
    complete: true,
    sourceSha: 'a'.repeat(40),
    executionId: 'scoped-cpu-unit',
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
  let explained = 0
  const result = await profilePerformanceQueries({
    capture,
    report,
    token: 'unit',
    sampleCpu: true,
    app: {
      async request(path) {
        await Promise.resolve()
        requests.push(path)
        capture.start('SELECT 1', [])(1)
        return new Response('ok')
      },
    },
    explain: async () => {
      expect(requests).toHaveLength(++explained)
      return [{ detail: 'SCAN CONSTANT ROW' }]
    },
  })
  expect(result.complete).toBe(true)
  expect(requests).toEqual(PERF_HTTP_SCENARIOS.map((scenario) => scenario.path))
  expect(JSON.stringify(report)).toBe(originalReport)
  for (const item of result.results) {
    expect(typeof item.cpuProfile?.functions).toBe('string')
    expect(item.value).toEqual({ status: 200, bytes: 2 })
    expect(item.statements).toHaveLength(1)
    expect(item.plans).toHaveLength(1)
  }
})
