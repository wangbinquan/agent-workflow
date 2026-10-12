// RFC-371: a failed/leased component cannot strand unrelated work, and stopping
// the daemon does not acknowledge a partially prepared component.
import { expect, test } from 'bun:test'
import { incrementalObservationWorker } from '@/modules/run-observability/application/incrementalObservationWorker'
import type { IncrementalObservationWork } from '@/modules/run-observability/ports/incrementalObservationProjection'

const work = (id: string): IncrementalObservationWork => ({
  id,
  source: 'original',
  revision: '1',
  components: [id],
})
test('a poison preparation is deferred and a later complete component is published in the same scheduling pass', async () => {
  const applied: string[] = [],
    deferred: string[] = [],
    failed: unknown[] = []
  let resolve!: () => void,
    passes = 0
  const finished = new Promise<void>((done) => {
    resolve = done
  })
  const worker = incrementalObservationWorker({
    bootstrap: async () => 0,
    dispatch: async () => 0,
    store: {
      pending: async () => (passes++ === 0 ? [work('bad'), work('good')] : []),
      change: async () => {
        throw new Error('No arbitrary projection transaction')
      },
    },
    prepare: async (work) => {
      if (work.id === 'bad') throw new Error('source unavailable')
      return work
    },
    apply: async (work) => {
      applied.push(work.id)
      resolve()
    },
    defer: async (work) => {
      deferred.push(work.id)
    },
    failed: (error) => failed.push(error),
  })
  worker.start()
  await finished
  await worker.stop()
  expect(applied).toEqual(['good'])
  expect(deferred).toEqual(['bad'])
  expect(failed).toHaveLength(1)
})
test('each bootstrap source page is continued while work is available, with no fixed work population maximum', async () => {
  let bootstrap = 0,
    applied = 0,
    resolve!: () => void
  const finished = new Promise<void>((done) => {
    resolve = done
  })
  const worker = incrementalObservationWorker({
    bootstrap: async () => (++bootstrap <= 3 ? 1 : 0),
    dispatch: async () => 0,
    store: {
      pending: async () => (applied < 301 ? [work(String(applied))] : []),
      change: async () => {
        throw new Error('No arbitrary projection transaction')
      },
    },
    prepare: async (work) => work,
    apply: async () => {
      if (++applied === 301) resolve()
    },
    defer: async () => {
      throw new Error('Successful work must not be deferred')
    },
    failed: (error) => {
      throw error
    },
  })
  worker.start()
  await finished
  await worker.stop()
  expect(applied).toBe(301)
  expect(bootstrap).toBeGreaterThanOrEqual(301)
})
