// RFC-201 — deterministic lock/dedup/generation tests for the daemon fence.

import { describe, expect, test } from 'bun:test'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('ResourceOperationCoordinator', () => {
  test('same id queues, different ids proceed, and thrown tasks release the lock', async () => {
    const c = new ResourceOperationCoordinator()
    const gate = deferred<void>()
    const order: string[] = []
    const a = c.runExclusive('m1', async () => {
      order.push('a-start')
      await gate.promise
      order.push('a-end')
    })
    const b = c.runExclusive('m1', () => {
      order.push('b')
    })
    await c.runExclusive('m2', () => {
      order.push('other')
    })
    expect(order).toEqual(['a-start', 'other'])
    gate.resolve()
    await Promise.all([a, b])
    await expect(
      c.runExclusive('m1', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await c.runExclusive('m1', () => order.push('after-error'))
    expect(order).toEqual(['a-start', 'other', 'a-end', 'b', 'after-error'])
    expect(c.__state()).toEqual({ locks: 0, operations: 0 })
  })

  test('same id+hash joins the complete promise and settle removes only that entry', async () => {
    const c = new ResourceOperationCoordinator()
    const gate = deferred<number>()
    let starts = 0
    const run = () =>
      c.runDeduplicatedOperation('m1', 'h1', async () => {
        starts += 1
        return gate.promise
      })
    const a = run()
    const b = run()
    await Promise.resolve()
    expect(starts).toBe(1)
    expect(c.__state().operations).toBe(1)
    gate.resolve(7)
    expect(await Promise.all([a, b])).toEqual([7, 7])
    expect(c.__state().operations).toBe(0)
  })

  test('different hashes get monotonic generations and causal same-ms timestamps', async () => {
    const c = new ResourceOperationCoordinator()
    await c.runDeduplicatedOperation('m1', 'h1', async () => {
      await c.runExclusive('m1', () => {
        expect(c.beginOperation('m1', 100, [101, 90])).toEqual({ generation: 1, startedAt: 101 })
      })
      await c.runExclusive('m1', () => {
        expect(c.nextCausalTimestamp('m1', 100, [101])).toBe(102)
        expect(c.beginOperation('m1', 100, [102])).toEqual({ generation: 2, startedAt: 103 })
        expect(c.latestGeneration('m1')).toBe(2)
        expect(c.activeLastStartedAt('m1')).toBe(103)
      })
    })
    expect(c.__state()).toEqual({ locks: 0, operations: 0 })
  })
})
