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
