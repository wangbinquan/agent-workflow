import { describe, expect, test } from 'bun:test'
import { createManagedPeriodicJob, type PeriodicTimerApi } from '../src/services/managedPeriodicJob'

class FakeTimers implements PeriodicTimerApi<number> {
  private nextId = 1
  readonly callbacks = new Map<number, () => void>()

  setTimeout = (callback: () => void): number => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout = (id: number): void => {
    this.callbacks.delete(id)
  }

  fire(id: number): void {
    const callback = this.callbacks.get(id)
    this.callbacks.delete(id)
    callback?.()
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('managed periodic Settings jobs', () => {
  // RFC-370: provider-session close must wait for a selected asynchronous read
  // and its admitted work. Stopping the timer alone is not a completed drain.
  test('stop fences timers while awaitIdle waits for the admitted tick to settle', async () => {
    const timers = new FakeTimers()
    const entered = deferred()
    const released = deferred()
    let runs = 0
    let settled = false
    const job = createManagedPeriodicJob({
      async run() {
        runs += 1
        entered.resolve()
        await released.promise
        settled = true
      },
      timerApi: timers,
    })
    job.reconfigure(10)
    timers.fire([...timers.callbacks.keys()][0]!)
    await entered.promise
    job.reconfigure(20)
    job.stop()
    let idle = false
    const pending = job.awaitIdle().then(() => {
      idle = true
    })
    try {
      await Promise.resolve()
      expect(idle).toBe(false)
      expect(settled).toBe(false)
      expect(timers.callbacks.size).toBe(0)
      released.resolve()
      await pending
      expect(idle).toBe(true)
      expect(settled).toBe(true)
      expect(runs).toBe(1)
      expect(timers.callbacks.size).toBe(0)
      await job.awaitIdle()
    } finally {
      released.resolve()
      job.stop()
      await pending
    }
  })

  test('awaitIdle includes asynchronous failure handling and does not rearm after stop', async () => {
    const timers = new FakeTimers()
    const entered = deferred()
    const released = deferred()
    const failure = new Error('selected settings unavailable')
    const errors: unknown[] = []
    const job = createManagedPeriodicJob({
      async run() {
        entered.resolve()
        await released.promise
        throw failure
      },
      onError: (error) => errors.push(error),
      timerApi: timers,
    })
    job.reconfigure(10)
    timers.fire([...timers.callbacks.keys()][0]!)
    await entered.promise
    job.stop()
    const pending = job.awaitIdle()
    try {
      expect(errors).toEqual([])
      released.resolve()
      await pending
      expect(errors).toEqual([failure])
      expect(timers.callbacks.size).toBe(0)
    } finally {
      released.resolve()
      job.stop()
      await pending
    }
  })

  test('invalid/overflow delays disable the job without arming a timer', () => {
    const timers = new FakeTimers()
    const invalid: unknown[] = []
    const job = createManagedPeriodicJob({
      run: () => {},
      timerApi: timers,
      minPositiveMs: 60_000,
      onInvalid: (value) => invalid.push(value),
    })

    expect(job.reconfigure(2_147_483_648)).toBe(false)
    expect(job.reconfigure(59_999)).toBe(false)
    expect(timers.callbacks.size).toBe(0)
    expect(invalid).toEqual([2_147_483_648, 59_999])
  })

  test('reconfigure during a slow tick rearms the latest cadence without overlap', async () => {
    const timers = new FakeTimers()
    const first = deferred()
    let runs = 0
    const job = createManagedPeriodicJob({
      run: async () => {
        runs += 1
        if (runs === 1) await first.promise
      },
      timerApi: timers,
    })

    expect(job.reconfigure(10)).toBe(true)
    timers.fire([...timers.callbacks.keys()][0]!)
    await Promise.resolve()
    expect(runs).toBe(1)

    expect(job.reconfigure(20)).toBe(true)
    timers.fire([...timers.callbacks.keys()][0]!)
    expect(runs).toBe(1)
    first.resolve()
    await Bun.sleep(0)
    expect(timers.callbacks.size).toBe(1)

    job.stop()
    expect(timers.callbacks.size).toBe(0)
  })
})
