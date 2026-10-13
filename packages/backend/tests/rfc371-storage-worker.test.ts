// A failed storage maintenance pass has no source ACK side effects and cannot stop ingestion.
import { expect, test } from 'bun:test'
import { observationStorageWorker } from '@/modules/run-observability/application/observationStorageWorker'
test('stop cancels a pending physical sample without recording an artificial storage failure', async () => {
  let entered!: () => void,
    reject!: (error: unknown) => void,
    cancellations = 0,
    failures = 0
  const started = new Promise<void>((resolve) => (entered = resolve)),
    worker = observationStorageWorker({
      collect: async () => 0,
      sample: () => {
        entered()
        return new Promise<void>((_resolve, fail) => (reject = fail))
      },
      cancelSample: () => {
        cancellations++
        reject(new DOMException('Storage sampling stopped', 'AbortError'))
      },
      failed: async () => {
        failures++
      },
    })
  worker.start()
  await started
  await worker.stop()
  expect(cancellations).toBe(1)
  expect(failures).toBe(0)
})
test('stop drains an in-flight collection and no second timer survives', async () => {
  let release!: () => void,
    calls = 0,
    samples = 0
  const held = new Promise<void>((r) => (release = r)),
    worker = observationStorageWorker({
      collect: async () => {
        calls++
        await held
        return 0
      },
      sample: async () => {
        samples++
      },
      failed: async () => {
        throw Error('unexpected')
      },
    })
  worker.start()
  worker.start()
  const stopped = worker.stop()
  release()
  await stopped
  expect(calls).toBe(1)
  expect(samples).toBe(1)
})
test('collection and status write failures are contained; sample never certifies a failed pass', async () => {
  let failures = 0,
    samples = 0
  const worker = observationStorageWorker({
    collect: async () => {
      throw Error('disk full')
    },
    sample: async () => {
      samples++
    },
    failed: async () => {
      failures++
      throw Error('disk still full')
    },
  })
  worker.start()
  await worker.drain()
  await worker.stop()
  expect(failures).toBe(1)
  expect(samples).toBe(0)
})

test('idle maintenance sleeps for a minute; productive and slow passes yield without dropping the next sweep', async () => {
  let clock = 1000,
    calls = 0,
    scheduled: (() => void) | undefined,
    cancelled = false
  const delays: number[] = [],
    worker = observationStorageWorker({
      now: () => clock,
      collect: async () => {
        calls++
        if (calls === 1) return 0
        clock += calls === 2 ? 5 : 200
        return 500
      },
      sample: async () => {},
      failed: async () => {
        throw Error('unexpected')
      },
      schedule: (callback, ms) => {
        delays.push(ms)
        scheduled = callback
        return () => {
          cancelled = true
        }
      },
    })
  worker.start()
  await worker.drain()
  expect(delays).toEqual([60000])
  worker.start()
  expect(calls).toBe(1)
  scheduled!()
  await worker.drain()
  expect(delays).toEqual([60000, 1000])
  scheduled!()
  await worker.drain()
  expect(delays).toEqual([60000, 1000, 3800])
  await worker.stop()
  expect(cancelled).toBe(true)
  scheduled!()
  expect(calls).toBe(3)
})

test('maintenance failure backs off for a minute without a one-second error loop', async () => {
  const delays: number[] = [],
    worker = observationStorageWorker({
      collect: async () => {
        throw Error('database busy')
      },
      sample: async () => {},
      failed: async () => {},
      schedule: (_callback, ms) => {
        delays.push(ms)
        return () => {}
      },
    })
  worker.start()
  await worker.drain()
  expect(delays).toEqual([60000])
  await worker.stop()
})

test('the same maintenance owner resumes after a completed pause without duplicate schedules', async () => {
  let calls = 0,
    schedules = 0,
    cancellations = 0
  const worker = observationStorageWorker({
    collect: async () => {
      calls++
      return 0
    },
    sample: async () => {},
    failed: async () => {},
    schedule: () => {
      schedules++
      return () => {
        cancellations++
      }
    },
  })
  for (let cycle = 1; cycle <= 3; cycle++) {
    worker.start()
    worker.start()
    await worker.drain()
    expect(calls).toBe(cycle)
    expect(schedules).toBe(cycle)
    await worker.stop()
    expect(cancellations).toBe(cycle)
  }
})

test('a protected live prefix advances promptly even when its page reclaims zero rows', async () => {
  let calls = 0
  const delays: number[] = [],
    worker = observationStorageWorker({
      collect: async () => ({ removed: 0, scanned: ++calls === 1 ? 500 : 0 }),
      sample: async () => {},
      failed: async () => {},
      schedule: (_callback, ms) => {
        delays.push(ms)
        return () => {}
      },
    })
  worker.start()
  await worker.drain()
  expect(delays).toEqual([1000])
  await worker.stop()
  worker.start()
  await worker.drain()
  expect(delays).toEqual([1000, 60000])
  await worker.stop()
})
