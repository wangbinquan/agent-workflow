// RFC-376 T10: retain platform behavior coverage after removing canonical projections.
import { expect, test } from 'bun:test'
import { defineBackgroundJob, defineManagedWorker } from '../src/platform/background/definitions'

test('managed background definitions expose frozen start/run/stop/health lifecycle contracts', () => {
  const lifecycle = {
    id: 'fixture',
    owner: 'fixture-owner',
    phase: 'after-ready' as const,
    dependencies: ['db'],
    readiness: () => 'ready' as const,
    state: () => ({ running: true }),
    start: () => undefined,
    stop: () => undefined,
    health: () => ({ status: 'healthy' as const, checkedAt: '2026-08-26T00:00:00Z' }),
    run: async () => undefined,
  }
  const job = defineBackgroundJob({ ...lifecycle, kind: 'periodic', cadenceMs: 1_000 })
  const worker = defineManagedWorker({ ...lifecycle, kind: 'long-running' })
  expect(Object.isFrozen(job)).toBe(true)
  expect(Object.isFrozen(job.dependencies)).toBe(true)
  expect(Object.isFrozen(worker)).toBe(true)
})
