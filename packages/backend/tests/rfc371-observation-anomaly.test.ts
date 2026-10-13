// RFC-371: source outages are not task failures; minimum samples, duration and recovery remain independent.
import { test, expect } from 'bun:test'
import {
  advanceObservationAnomaly,
  type ObservationAnomalySample,
} from '../src/modules/run-observability/domain/observationAnomaly'
const sample: ObservationAnomalySample = {
  key: 'original-task:usage-missing',
  taskId: 'original-task',
  taskName: 'Original task',
  rule: 'usage-missing',
  condition: true,
  sourceState: 'available',
  samples: '1',
  minimumSamples: '2',
  windowMs: 60000,
  durationMs: 10000,
  observedAt: 100000,
  evidence: ['native-capture-unobserved'],
  sourceRevision: '1',
}
test('low sample count suppresses a new issue; duration and source recovery produce one stable finding', () => {
  const id = () => 'stable-original'
  expect(advanceObservationAnomaly(undefined, sample, id)).toBeUndefined()
  const pending = advanceObservationAnomaly(undefined, { ...sample, samples: '2' }, id)!
  expect(pending.state).toBe('pending')
  const active = advanceObservationAnomaly(
    pending,
    { ...sample, samples: '3', observedAt: 110000, sourceRevision: '2' },
    id,
  )!
  expect(active.state).toBe('firing')
  expect(active.id).toBe(pending.id)
  expect(
    advanceObservationAnomaly(
      active,
      { ...sample, samples: '3', condition: null, sourceState: 'unavailable', observedAt: 120000 },
      id,
    ),
  ).toMatchObject({ state: 'firing', sourceState: 'unavailable' })
  const resolved = advanceObservationAnomaly(
    active,
    { ...sample, samples: '3', condition: false, observedAt: 130000 },
    id,
  )!
  expect(resolved).toMatchObject({ state: 'resolved', resolvedAt: 130000 })
  expect(
    advanceObservationAnomaly(
      resolved,
      { ...sample, samples: '3', condition: false, observedAt: 140000 },
      id,
    ),
  ).toEqual(resolved)
  expect(() => advanceObservationAnomaly(active, { ...sample, observedAt: 1 }, id)).toThrow(
    'regressed',
  )
})
