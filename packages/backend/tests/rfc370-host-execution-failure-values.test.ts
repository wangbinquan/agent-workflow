import { expect, test } from 'bun:test'
import { createHostExecutionAuthorityLifecycle } from '@/modules/system-operations/application/hostExecutionAuthority'
import type { HostExecutionAuthorityDriver } from '@/modules/system-operations/application/ports/hostExecutionAuthority'

function fixture(
  options: {
    readonly retirement?: { readonly error: unknown }
    readonly listener?: { readonly error: unknown }
  } = {},
) {
  let observer: Parameters<HostExecutionAuthorityDriver['subscribe']>[0] | undefined
  let retireFails = options.retirement !== undefined
  const failures: unknown[] = [],
    released: object[] = []
  const first = Object.freeze({}),
    fresh = Object.freeze({})
  const lifecycle = createHostExecutionAuthorityLifecycle({
    generation: 'raw-failure-generation',
    mode: 'execution',
    driver: {
      claim: () => ({ kind: 'granted', reference: first }),
      renew: (reference) => ({ kind: 'granted', reference }),
      activate: ({ reference }) => ({ kind: 'granted', reference }),
      quiesce() {},
      release(reference) {
        if (retireFails) {
          retireFails = false
          return Promise.reject(options.retirement!.error)
        }
        released.push(reference)
      },
      subscribe(input) {
        observer = input
        return { close() {} }
      },
    },
    recovery: {
      kind: 'durable-intent',
      prepare: () => ({
        kind: 'prepared',
        preparationDigest: 'raw-failure-recovery',
        acceptedTaskContractVersions: ['task-intent:v1'],
        readyGroups: ['task'],
      }),
      quiesce() {},
      drain() {},
    },
    runtime: { start() {}, quiesce() {}, drain() {} },
    onFailure(error) {
      failures.push(error)
      if (options.listener !== undefined) throw options.listener.error
    },
  })
  return {
    lifecycle,
    failures,
    released,
    first,
    fresh,
    fail(error: unknown) {
      if (observer === undefined) throw new Error('missing real lifecycle subscription')
      observer.onFailure(error)
    },
    lose() {
      if (observer === undefined) throw new Error('missing real lifecycle subscription')
      observer.onObservation({ kind: 'lost', reason: 'test authority lost' })
    },
    reacquire() {
      if (observer === undefined) throw new Error('missing real lifecycle subscription')
      observer.onObservation({ kind: 'granted', reference: fresh })
    },
  }
}

async function rejection(lifecycle: ReturnType<typeof fixture>['lifecycle']) {
  const result = await lifecycle.settled().then(
    () => ({ kind: 'fulfilled' as const }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  )
  expect(result.kind).toBe('rejected')
  if (result.kind !== 'rejected') throw new Error('the original failure was swallowed')
  return result.error
}

const values: readonly [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['false', false],
  ['zero', 0],
  ['Error', new Error('original driver failure')],
]
for (const [name, error] of values) {
  for (const source of ['subscription', 'retirement'] as const) {
    test(`${source} ${name} failure rejects settlement with its exact raw value and resets after fresh adoption`, async () => {
      const f = fixture(source === 'retirement' ? { retirement: { error } } : {})
      try {
        await f.lifecycle.start()
        expect(f.lifecycle.queries.snapshot().phase).toBe('active')
        if (source === 'subscription') f.fail(error)
        else f.lose()
        expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
        expect(await rejection(f.lifecycle)).toBe(error)
        expect(f.failures).toEqual([error])
        f.reacquire()
        await f.lifecycle.settled()
        expect(f.lifecycle.queries.snapshot()).toMatchObject({
          phase: 'active',
          readyGroups: ['task'],
        })
        expect(f.released).toEqual([f.first])
      } finally {
        await f.lifecycle.close()
      }
      await f.lifecycle.settled()
      expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
      expect(f.released).toEqual([f.first, f.fresh])
    })
  }
}

test('successful close clears an undefined subscription failure at the original close ACK', async () => {
  const f = fixture()
  await f.lifecycle.start()
  f.fail(undefined)
  expect(await rejection(f.lifecycle)).toBeUndefined()
  await f.lifecycle.close()
  await f.lifecycle.settled()
  expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
  expect(f.released).toEqual([f.first])
})

for (const [name, error] of [
  ['undefined', undefined],
  ['Error', new Error('original listener failure')],
] as const) {
  test(`${name} listener failure aggregates the exact undefined driver failure and original listener value`, async () => {
    const f = fixture({ listener: { error } })
    try {
      await f.lifecycle.start()
      f.fail(undefined)
      const failure = await rejection(f.lifecycle)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([undefined, error])
      expect(f.failures).toEqual([undefined])
      expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
    } finally {
      await f.lifecycle.close()
    }
    await f.lifecycle.settled()
  })
}
