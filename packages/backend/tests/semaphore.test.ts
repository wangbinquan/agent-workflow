// FIFO counting semaphore primitive (P-3-05).

import { describe, expect, test } from 'bun:test'
import { Semaphore } from '../src/util/semaphore'

describe('Semaphore', () => {
  test('rejects non-positive capacity at construction', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  test('acquire resolves immediately when a slot is free', async () => {
    const sem = new Semaphore(2)
    const r1 = await sem.acquire()
    expect(sem.available).toBe(1)
    const r2 = await sem.acquire()
    expect(sem.available).toBe(0)
    r1()
    expect(sem.available).toBe(1)
    r2()
    expect(sem.available).toBe(2)
  })

  test('queues callers in FIFO order when full', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    const releases: Array<() => void> = []

    const p1 = sem.acquire().then((r) => {
      order.push(1)
      releases.push(r)
    })
    const p2 = sem.acquire().then((r) => {
      order.push(2)
      releases.push(r)
    })
    const p3 = sem.acquire().then((r) => {
      order.push(3)
      releases.push(r)
    })

    // p1 resolves immediately (capacity 1, was free).
    await p1
    expect(order).toEqual([1])
    expect(sem.queueLength).toBe(2)

    // Release → p2 wakes up.
    releases.pop()!()
    await p2
    expect(order).toEqual([1, 2])
    expect(sem.queueLength).toBe(1)

    // Release → p3 wakes up.
    releases.pop()!()
    await p3
    expect(order).toEqual([1, 2, 3])
    expect(sem.queueLength).toBe(0)

    releases.pop()!() // tidy
  })

  test('run() releases the slot even when fn throws', async () => {
    const sem = new Semaphore(1)
    await expect(
      sem.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(sem.available).toBe(1)
  })

  test('run() limits concurrent in-flight work', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(5)
        active -= 1
      }),
    )
    await Promise.all(tasks)
    expect(peak).toBe(2)
  })

  test('上线前加固：resize grows immediately and shrinks without preempting holders', async () => {
    const sem = new Semaphore(2)
    const release1 = await sem.acquire()
    const release2 = await sem.acquire()

    sem.resize(1)
    expect(sem.capacity).toBe(1)
    expect(sem.available).toBe(0)
    let thirdEntered = false
    const third = sem.acquire().then((release) => {
      thirdEntered = true
      return release
    })
    await Promise.resolve()
    expect(thirdEntered).toBe(false)
    release1()
    await Promise.resolve()
    expect(thirdEntered).toBe(false)
    release2()
    const release3 = await third
    expect(thirdEntered).toBe(true)

    const fourth = sem.acquire()
    sem.resize(2)
    const release4 = await fourth
    expect(sem.capacity).toBe(2)
    release3()
    release4()
  })

  test('release functions are idempotent so a cleanup bug cannot inflate capacity', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release()
    expect(sem.available).toBe(1)
  })
})
