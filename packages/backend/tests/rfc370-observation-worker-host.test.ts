// RFC-370 only changes who may start the original workers. Their accepted
// preparation, apply/defer and storage receipts remain the original operations.
import { expect, test } from 'bun:test'
import { incrementalObservationWorker } from '@/modules/run-observability/application/incrementalObservationWorker'
import { observationStorageWorker } from '@/modules/run-observability/application/observationStorageWorker'
import type { IncrementalObservationWork } from '@/modules/run-observability/ports/incrementalObservationProjection'
import { deferred, nextTurn } from './helpers/taskHostExecution'

const work = (id: string): IncrementalObservationWork => ({
  id,
  source: 'original',
  revision: '1',
  components: [id],
})
const unexpected = (): never => {
  throw new Error('unadmitted observation work')
}

test('projection loss during original bootstrap drains that operation without dispatching another unit', async () => {
  let current = true
  const entered = deferred(),
    release = deferred()
  const worker = incrementalObservationWorker({
    executionMode: 'host',
    bootstrap: async (signal) => {
      entered.resolve()
      await release.promise
      expect(signal.aborted).toBe(false)
      return 1
    },
    dispatch: unexpected,
    store: { pending: unexpected, change: unexpected },
    prepare: unexpected,
    apply: unexpected,
    defer: unexpected,
    failed: unexpected,
  })
  expect(() => worker.start()).toThrow('host-lifetime-required')
  worker.start({ current: () => current })
  await entered.promise
  current = false
  worker.quiesce()
  let drained = false
  const draining = worker.drainAuthority().then(() => {
    drained = true
  })
  await nextTurn()
  expect(drained).toBe(false)
  release.resolve()
  await draining
})

test('an admitted projection component finishes the exact prepare/apply chain; the next component remains pending', async () => {
  let current = true
  const entered = deferred(),
    release = deferred(),
    first = work('first'),
    second = work('second'),
    applied: IncrementalObservationWork[] = []
  const worker = incrementalObservationWorker({
    executionMode: 'host',
    bootstrap: async () => 0,
    dispatch: async () => 0,
    store: { pending: async () => [first, second], change: unexpected },
    prepare: async (item, signal) => {
      expect(item).toBe(first)
      entered.resolve()
      await release.promise
      expect(signal.aborted).toBe(false)
      return item
    },
    apply: async (item) => {
      applied.push(item)
    },
    defer: unexpected,
    failed: unexpected,
  })
  worker.start({ current: () => current })
  await entered.promise
  current = false
  worker.quiesce()
  const draining = worker.drainAuthority()
  release.resolve()
  await draining
  expect(applied).toEqual([first])
})

test('a failed original projection defer is retried as a receipt, never a second prepare', async () => {
  let current = true,
    allow = false,
    prepared = 0,
    writes = 0
  const failed = deferred(),
    first = work('failed'),
    sourceError = new Error('original source error')
  const worker = incrementalObservationWorker({
    executionMode: 'host',
    bootstrap: async () => 0,
    dispatch: async () => 0,
    store: { pending: async () => [first, work('later')], change: unexpected },
    prepare: async () => {
      prepared++
      throw sourceError
    },
    apply: unexpected,
    defer: async (item, error) => {
      expect(item).toBe(first)
      expect(error).toBe(sourceError)
      writes++
      if (!allow) throw new Error('defer ACK missing')
    },
    failed: () => {
      failed.resolve()
    },
  })
  worker.start({ current: () => current })
  await failed.promise
  current = false
  worker.quiesce()
  await expect(worker.drainAuthority()).rejects.toThrow('defer ACK missing')
  allow = true
  await worker.drainAuthority()
  expect(prepared).toBe(1)
  expect(writes).toBe(3)
})

test('storage loss finishes an admitted sweep without starting sampling or rearming a timer', async () => {
  let current = true
  const entered = deferred(),
    release = deferred()
  const worker = observationStorageWorker({
    executionMode: 'host',
    collect: async () => {
      entered.resolve()
      await release.promise
      return 2
    },
    sample: unexpected,
    failed: unexpected,
    schedule: unexpected,
  })
  expect(() => worker.start()).toThrow('host-lifetime-required')
  worker.start({ current: () => current })
  await entered.promise
  current = false
  worker.quiesce()
  let drained = false
  const draining = worker.drainAuthority().then(() => {
    drained = true
  })
  await nextTurn()
  expect(drained).toBe(false)
  release.resolve()
  await draining
})

test('storage failure receipt remains mandatory for host drain', async () => {
  let current = true,
    allow = false,
    swept = 0,
    writes = 0
  const entered = deferred(),
    original = new Error('original storage failure')
  const worker = observationStorageWorker({
    executionMode: 'host',
    collect: async () => {
      swept++
      throw original
    },
    sample: unexpected,
    failed: async (error) => {
      expect(error).toBe(original)
      writes++
      entered.resolve()
      if (!allow) throw new Error('storage receipt missing')
    },
    schedule: unexpected,
  })
  worker.start({ current: () => current })
  await entered.promise
  current = false
  worker.quiesce()
  await expect(worker.drainAuthority()).rejects.toThrow('storage receipt missing')
  allow = true
  await worker.drainAuthority()
  expect(swept).toBe(1)
  expect(writes).toBe(3)
})

test('normal projection stop still aborts original preparation without applying a partial component', async () => {
  const entered = deferred()
  let aborted = false
  const worker = incrementalObservationWorker({
    executionMode: 'host',
    bootstrap: async () => 0,
    dispatch: async () => 0,
    store: { pending: async () => [work('normal-pause')], change: unexpected },
    prepare: async (_item, signal) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      signal.throwIfAborted()
      throw new Error('normal pause did not abort')
    },
    apply: unexpected,
    defer: unexpected,
    failed: unexpected,
  })
  worker.start({ current: () => true })
  await entered.promise
  await worker.stop()
  await worker.drainAuthority()
  expect(aborted).toBe(true)
})
