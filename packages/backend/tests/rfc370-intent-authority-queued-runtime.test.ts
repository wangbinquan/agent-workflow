// H7: an old queued admission must check its own grant after awaited config,
// retain unread IDs, and settle actual batch ACKs before a new lifetime starts.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { composeIntentQueuedResumption } from '../src/modules/intent/composition/queuedResumption'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const config = (rounds: number): Config => ({
  ...structuredClone(DEFAULT_CONFIG),
  intentBuilderMaxGenerateRounds: rounds,
})

describe('RFC-370 selected Intent queued admission', () => {
  test('standby retains frozen IDs without reading config or admitting a batch', async () => {
    let reads = 0
    const seen: Array<{ ids: readonly string[]; snapshot: Config }> = []
    const resumed = deferred<void>()
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          reads += 1
          return config(17)
        },
      },
      async resume(ids, snapshot) {
        seen.push({ ids, snapshot })
        resumed.resolve()
      },
      onError(error) {
        throw error
      },
    })
    const ids = ['first', 'first']
    bindings.enqueue(ids)
    ids.push('mutated')
    const standby = bindings.runtimeFactory.startAuthority({ current: () => false })
    await Promise.resolve()
    bindings.enqueue(['second', 'first'])
    expect(reads).toBe(0)
    expect(seen).toEqual([])
    standby.stop()
    await standby.drain()
    const active = bindings.runtimeFactory.startAuthority({ current: () => true })
    try {
      await resumed.promise
      expect(reads).toBe(1)
      expect(seen.map(({ ids }) => ids)).toEqual([['first', 'second']])
      expect(Object.isFrozen(seen[0]!.ids)).toBe(true)
      expect(seen[0]!.snapshot.intentBuilderMaxGenerateRounds).toBe(17)
    } finally {
      active.stop()
      await active.drain()
    }
  })

  test('loss after a held config ACK retains IDs before queued quiesce arrives', async () => {
    let current = true
    let reads = 0
    const entered = deferred<void>()
    const read = deferred<Config>()
    const lossObserved = deferred<void>()
    const resumed = deferred<void>()
    const seen: Array<{ ids: readonly string[]; snapshot: Config }> = []
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          reads += 1
          if (reads === 1) {
            entered.resolve()
            return read.promise
          }
          return config(29)
        },
      },
      async resume(ids, snapshot) {
        seen.push({ ids, snapshot })
        resumed.resolve()
      },
      onError(error) {
        throw error
      },
    })
    bindings.enqueue(['old', 'old'])
    const old = bindings.runtimeFactory.startAuthority({
      current() {
        if (!current) lossObserved.resolve()
        return current
      },
    })
    await entered.promise
    current = false
    read.resolve(config(11))
    // No stop has run: the actual post-read check must observe the old loss.
    await lossObserved.promise
    bindings.enqueue(['new', 'old'])
    expect(seen).toEqual([])
    expect(reads).toBe(1)
    old.stop()
    await old.drain()
    const next = bindings.runtimeFactory.startAuthority({ current: () => true })
    try {
      await resumed.promise
      expect(reads).toBe(2)
      expect(seen.map(({ ids }) => ids)).toEqual([['old', 'new']])
      expect(seen[0]!.snapshot.intentBuilderMaxGenerateRounds).toBe(29)
    } finally {
      next.stop()
      await next.drain()
    }
  }, 30_000)

  test('loss drain awaits admitted resume and old drain cannot retire the next lifetime', async () => {
    let current = true
    let rounds = 3
    const admitted = deferred<void>()
    const admissionAck = deferred<void>()
    const nextAdmitted = deferred<void>()
    const seen: Array<{ ids: readonly string[]; rounds: number | undefined }> = []
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => config(rounds) },
      async resume(ids, snapshot) {
        seen.push({ ids, rounds: snapshot.intentBuilderMaxGenerateRounds })
        if (seen.length === 1) {
          admitted.resolve()
          await admissionAck.promise
        } else nextAdmitted.resolve()
      },
      onError(error) {
        throw error
      },
    })
    const old = bindings.runtimeFactory.startAuthority({ current: () => current })
    bindings.enqueue(['already-admitted'])
    await admitted.promise
    current = false
    old.stop()
    bindings.enqueue(['next'])
    let drained = false
    const draining = old.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(() => bindings.runtimeFactory.startAuthority({ current: () => true })).toThrow(
      'already-started',
    )
    admissionAck.resolve()
    await draining
    rounds = 7
    const next = bindings.runtimeFactory.startAuthority({ current: () => true })
    try {
      await nextAdmitted.promise
      old.stop()
      await old.drain()
      expect(() => bindings.runtimeFactory.startAuthority({ current: () => true })).toThrow(
        'already-started',
      )
      expect(seen).toEqual([
        { ids: ['already-admitted'], rounds: 3 },
        { ids: ['next'], rounds: 7 },
      ])
    } finally {
      next.stop()
      await next.drain()
    }
  }, 30_000)

  test('the lifetime captures the original current function and its receiver', async () => {
    let valid = true
    let reads = 0
    let currentCalls = 0
    const authority = {
      current() {
        expect<unknown>(this).toBe(authority)
        currentCalls += 1
        return valid
      },
    }
    const bindings = composeIntentQueuedResumption({
      configuration: {
        read() {
          reads += 1
          return config(5)
        },
      },
      resume: async () => {},
      onError(error) {
        throw error
      },
    })
    const old = bindings.runtimeFactory.startAuthority(authority)
    authority.current = () => {
      throw new Error('replaced function must not become the old grant')
    }
    valid = false
    bindings.enqueue(['retained'])
    expect(currentCalls).toBe(1)
    expect(reads).toBe(0)
    old.stop()
    await old.drain()
    const next = bindings.runtimeFactory.startAuthority({ current: () => true })
    await Promise.resolve()
    next.stop()
    await next.drain()
    expect(reads).toBe(1)
  })

  test('a missing selected current fails before consuming the native pending batch', async () => {
    const resumed = deferred<void>()
    const seen: Array<readonly string[]> = []
    const bindings = composeIntentQueuedResumption({
      configuration: { read: () => config(13) },
      async resume(ids) {
        seen.push(ids)
        resumed.resolve()
      },
      onError(error) {
        throw error
      },
    })
    bindings.enqueue(['native'])
    expect(() => bindings.runtimeFactory.startAuthority({ current: undefined as never })).toThrow(
      'current-missing',
    )
    const native = bindings.runtimeFactory.start()
    try {
      await resumed.promise
      expect(seen).toEqual([['native']])
    } finally {
      native.stop()
      await native.drain()
    }
  })
})
