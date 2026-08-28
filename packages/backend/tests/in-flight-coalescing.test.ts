// RFC-338 hosted 100-client regression: a synchronous request burst must share
// one in-progress DB projection, while later requests still observe fresh data.

import { describe, expect, test } from 'bun:test'
import { createInFlightCoalescer } from '../src/util/inFlight'

describe('in-flight request coalescing', () => {
  test('overlapping callers share one loader and settled values are never cached', async () => {
    const coalesce = createInFlightCoalescer<string, number>()
    let loads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = async (): Promise<number> => {
      loads += 1
      await gate
      return loads
    }

    const first = coalesce('same', load)
    const second = coalesce('same', load)
    expect(first).toBe(second)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(loads).toBe(1)
    release?.()
    expect(await Promise.all([first, second])).toEqual([1, 1])

    expect(await coalesce('same', load)).toBe(2)
    expect(loads).toBe(2)
  })

  test('a rejected loader is shared but does not poison the next attempt', async () => {
    const coalesce = createInFlightCoalescer<string, number>()
    let loads = 0
    const failure = new Error('first-load-failed')
    const load = async (): Promise<number> => {
      loads += 1
      if (loads === 1) throw failure
      return loads
    }

    const first = coalesce('same', load)
    const second = coalesce('same', load)
    expect(first).toBe(second)
    expect(await first.catch((error: unknown) => error)).toBe(failure)
    expect(await coalesce('same', load)).toBe(2)
  })
})
