// RFC-359 W52: share the complete apply queue while retaining independent module lock domains.
import { expect, test } from 'bun:test'

import { createResourcePackageApplyLock } from '../src/platform/persistence/resourcePackageApplyLock'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

test('resource-package applies serialize the same key and preserve queued results', async () => {
  const withLock = createResourcePackageApplyLock()
  const events: string[] = []
  const firstEntered = deferred<void>()
  const secondEntered = deferred<void>()
  const releaseFirst = deferred<{ receipt: string }>()
  const releaseSecond = deferred<{ receipt: string }>()
  const firstValue = { receipt: 'first' }
  const secondValue = { receipt: 'second' }
  const thirdValue = { receipt: 'third' }
  const first = withLock('shared', async () => {
    events.push('first:start')
    firstEntered.resolve()
    const value = await releaseFirst.promise
    events.push('first:end')
    return value
  })
  const second = withLock('shared', async () => {
    events.push('second:start')
    secondEntered.resolve()
    const value = await releaseSecond.promise
    events.push('second:end')
    return value
  })
  expect(events).toEqual([])
  await firstEntered.promise
  expect(events).toEqual(['first:start'])
  releaseFirst.resolve(firstValue)
  expect(await first).toBe(firstValue)
  await secondEntered.promise

  const third = withLock('shared', async () => {
    events.push('third:start')
    return thirdValue
  })
  await withLock('independent-witness', async () => undefined)
  expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  releaseSecond.resolve(secondValue)
  expect(await second).toBe(secondValue)
  expect(await third).toBe(thirdValue)
  expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end', 'third:start'])
})

test('resource-package applies on different keys can finish while another key is held', async () => {
  const withLock = createResourcePackageApplyLock()
  const entered = deferred<void>()
  const release = deferred<void>()
  const events: string[] = []
  const held = withLock('held', async () => {
    events.push('held:start')
    entered.resolve()
    await release.promise
    events.push('held:end')
  })
  await entered.promise
  const result = { receipt: 'independent' }
  expect(
    await withLock('other', async () => {
      events.push('other:complete')
      return result
    }),
  ).toBe(result)
  expect(events).toEqual(['held:start', 'other:complete'])
  release.resolve()
  await held
  expect(events).toEqual(['held:start', 'other:complete', 'held:end'])
})

test('resource-package queues recover from synchronous throws and rejected operations', async () => {
  for (const mode of ['throw', 'reject'] as const) {
    const withLock = createResourcePackageApplyLock()
    const sentinel = new Error(mode)
    const events: string[] = []
    const failed = withLock('shared', () => {
      events.push('failed:start')
      if (mode === 'throw') throw sentinel
      return Promise.reject(sentinel)
    }).catch((error: unknown) => error)
    const result = { receipt: mode }
    const next = withLock('shared', async () => {
      events.push('next:start')
      return result
    })
    expect(await failed).toBe(sentinel)
    expect(await next).toBe(result)
    expect(events).toEqual(['failed:start', 'next:start'])
    expect(await withLock('shared', async () => result)).toBe(result)
  }
})

test('resource-package apply factories keep the same key in independent lock domains', async () => {
  const firstDomain = createResourcePackageApplyLock()
  const secondDomain = createResourcePackageApplyLock()
  const entered = deferred<void>()
  const release = deferred<void>()
  const events: string[] = []
  const held = firstDomain('shared', async () => {
    events.push('first:start')
    entered.resolve()
    await release.promise
    events.push('first:end')
  })
  await entered.promise
  const result = { receipt: 'second-domain' }
  expect(
    await secondDomain('shared', async () => {
      events.push('second:complete')
      return result
    }),
  ).toBe(result)
  expect(events).toEqual(['first:start', 'second:complete'])
  release.resolve()
  await held
  expect(events).toEqual(['first:start', 'second:complete', 'first:end'])
})
