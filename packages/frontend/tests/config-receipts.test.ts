// RFC-201 PR-A regression lock: config GETs carry issue-order receipts, local
// PUTs are FIFO, and an older GET can never roll back an exact PUT response.

import { DEFAULT_CONFIG, type Config, type ConfigPatch } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  ConfigReceiptCoordinator,
  ConfigAmbiguousWriteError,
  ConfigReceiptGenerationError,
  ConfigWriteQueueBlockedError,
  shouldAcceptConfigReadReceipt,
  type ConfigReceiptTransport,
} from '@/lib/config-receipts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function config(language: Config['language']): Config {
  return { ...DEFAULT_CONFIG, language }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('ConfigReceiptCoordinator', () => {
  test('GET(A) issued -> PUT(B) settles -> late A is fenced and post-settle GET(C) converges', async () => {
    const getA = deferred<Config>()
    const getC = deferred<Config>()
    const pendingReads = [getA.promise, getC.promise]
    let readCalls = 0
    const transport: ConfigReceiptTransport = {
      read: () => {
        readCalls += 1
        const next = pendingReads.shift()
        if (next === undefined) throw new Error('unexpected config read')
        return next
      },
      write: async () => config('en-US'),
    }
    const coordinator = new ConfigReceiptCoordinator(transport)
    const published: string[] = []
    const unsubscribe = coordinator.subscribe(() => {
      const receipt = coordinator.getSnapshot()
      published.push(
        receipt === undefined
          ? 'reset'
          : `${receipt.type}:${receipt.type === 'read' ? receipt.issuedEpoch : receipt.writeEpoch}`,
      )
    })

    const pendingAReceipt = coordinator.read()
    const writeReceipt = await coordinator.write({ language: 'en-US' })

    expect(writeReceipt).toMatchObject({
      type: 'write',
      config: config('en-US'),
      generation: 1,
      writeEpoch: 1,
      ignoreReadsThroughEpoch: 1,
    })
    expect(readCalls).toBe(2)

    getA.resolve(config('zh-CN'))
    const lateAReceipt = await pendingAReceipt
    expect(lateAReceipt).toMatchObject({ type: 'read', issuedEpoch: 1 })
    expect(shouldAcceptConfigReadReceipt(lateAReceipt, writeReceipt)).toBe(false)

    getC.resolve(config('en-US'))
    const cReceipt = await writeReceipt.postSettleRefetch
    expect(cReceipt).toMatchObject({
      type: 'read',
      generation: 1,
      issuedEpoch: 2,
      config: config('en-US'),
    })
    expect(shouldAcceptConfigReadReceipt(cReceipt, writeReceipt)).toBe(true)
    expect(published).toEqual(['write:1', 'read:2'])
    unsubscribe()
  })

  test('PUT-A response paused keeps PUT-B out of transport until A settles', async () => {
    const putA = deferred<Config>()
    const putB = deferred<Config>()
    const pendingWrites = [putA.promise, putB.promise]
    const started: ConfigPatch[] = []
    let active = 0
    let maxActive = 0
    const transport: ConfigReceiptTransport = {
      read: async () => config('zh-CN'),
      write: (patch) => {
        started.push(patch)
        active += 1
        maxActive = Math.max(maxActive, active)
        const next = pendingWrites.shift()
        if (next === undefined) throw new Error('unexpected config write')
        return next.finally(() => {
          active -= 1
        })
      },
    }
    const coordinator = new ConfigReceiptCoordinator(transport)

    const first = coordinator.write({ language: 'en-US' })
    const second = coordinator.write({ language: 'zh-CN' })
    await flushMicrotasks()
    expect(started).toEqual([{ language: 'en-US' }])

    putA.resolve(config('en-US'))
    const firstReceipt = await first
    await flushMicrotasks()
    expect(started).toEqual([{ language: 'en-US' }, { language: 'zh-CN' }])
    expect(firstReceipt.writeEpoch).toBe(1)

    putB.resolve(config('zh-CN'))
    const secondReceipt = await second
    expect(secondReceipt.writeEpoch).toBe(2)
    expect(maxActive).toBe(1)
    await Promise.all([firstReceipt.postSettleRefetch, secondReceipt.postSettleRefetch])
  })

  test('a failed PUT rejects its caller without poisoning the next queued writer', async () => {
    const failure = new Error('write failed')
    let attempt = 0
    const transport: ConfigReceiptTransport = {
      read: async () => config('zh-CN'),
      write: async () => {
        attempt += 1
        if (attempt === 1) throw failure
        return config('zh-CN')
      },
    }
    const coordinator = new ConfigReceiptCoordinator(transport, {
      isDefinitiveWriteError: (error) => error === failure,
    })

    const failed = coordinator.write({ language: 'en-US' })
    const recovered = coordinator.write({ language: 'zh-CN' })

    await expect(failed).rejects.toBe(failure)
    const receipt = await recovered
    expect(receipt).toMatchObject({ type: 'write', writeEpoch: 2, config: config('zh-CN') })
    expect(attempt).toBe(2)
    await receipt.postSettleRefetch
  })

  test('an outcome-unknown PUT fail-closes queued writers before transport', async () => {
    const lostResponse = new TypeError('connection closed after send')
    const started: ConfigPatch[] = []
    const coordinator = new ConfigReceiptCoordinator({
      read: async () => config('en-US'),
      write: async (patch) => {
        started.push(patch)
        throw lostResponse
      },
    })

    const first = coordinator.write({ language: 'en-US' })
    const second = coordinator.write({ theme: 'dark' })

    await expect(first).rejects.toMatchObject({
      code: 'config-write-outcome-unknown',
      originalError: lostResponse,
    })
    await expect(first).rejects.toBeInstanceOf(ConfigAmbiguousWriteError)
    await expect(second).rejects.toMatchObject({
      code: 'config-write-queue-blocked',
      blockedByWriteEpoch: 1,
    })
    await expect(second).rejects.toBeInstanceOf(ConfigWriteQueueBlockedError)
    expect(started).toEqual([{ language: 'en-US' }])
  })

  test('readConfig returns the latest accepted write value when its raw GET completes late', async () => {
    const lateRead = deferred<Config>()
    const postWriteRead = deferred<Config>()
    const pendingReads = [lateRead.promise, postWriteRead.promise]
    const coordinator = new ConfigReceiptCoordinator({
      read: () => {
        const next = pendingReads.shift()
        if (next === undefined) throw new Error('unexpected config read')
        return next
      },
      write: async () => config('en-US'),
    })

    const queryResult = coordinator.readConfig()
    const writeReceipt = await coordinator.write({ language: 'en-US' })
    lateRead.resolve(config('zh-CN'))

    await expect(queryResult).resolves.toEqual(config('en-US'))
    postWriteRead.resolve(config('en-US'))
    await writeReceipt.postSettleRefetch
  })

  test('generation reset rejects an old daemon GET and starts a clean receipt snapshot', async () => {
    const oldRead = deferred<Config>()
    const reads = [oldRead.promise, Promise.resolve(config('en-US'))]
    const coordinator = new ConfigReceiptCoordinator({
      read: () => {
        const next = reads.shift()
        if (next === undefined) throw new Error('unexpected config read')
        return next
      },
      write: async () => config('en-US'),
    })
    const snapshots: Array<number | undefined> = []
    coordinator.subscribe(() => snapshots.push(coordinator.getSnapshot()?.generation))

    const oldRequest = coordinator.readConfig()
    await flushMicrotasks()
    expect(coordinator.resetGeneration()).toBe(2)
    oldRead.resolve(config('zh-CN'))

    await expect(oldRequest).rejects.toBeInstanceOf(ConfigReceiptGenerationError)
    await expect(oldRequest).rejects.toMatchObject({
      code: 'config-receipt-generation-changed',
      expectedGeneration: 1,
      currentGeneration: 2,
    })
    await expect(coordinator.readConfig()).resolves.toEqual(config('en-US'))
    expect(coordinator.getSnapshot()).toMatchObject({ type: 'read', generation: 2 })
    expect(snapshots).toEqual([undefined, 2])
  })

  test('generation reset detaches queued old-daemon writes from the new writer FIFO', async () => {
    const oldInFlight = deferred<Config>()
    const started: ConfigPatch[] = []
    const coordinator = new ConfigReceiptCoordinator({
      read: async () => config('en-US'),
      write: (patch) => {
        started.push(patch)
        return patch.language === 'en-US' ? oldInFlight.promise : Promise.resolve(config('en-US'))
      },
    })

    const oldFirst = coordinator.write({ language: 'en-US' })
    const oldQueued = coordinator.write({ theme: 'dark' })
    await flushMicrotasks()
    expect(started).toEqual([{ language: 'en-US' }])

    coordinator.resetGeneration()
    const fresh = coordinator.write({ logLevel: 'debug' })
    const freshReceipt = await fresh
    expect(started).toEqual([{ language: 'en-US' }, { logLevel: 'debug' }])

    oldInFlight.resolve(config('en-US'))
    await expect(oldFirst).rejects.toBeInstanceOf(ConfigReceiptGenerationError)
    await expect(oldQueued).rejects.toBeInstanceOf(ConfigReceiptGenerationError)
    expect(started).toEqual([{ language: 'en-US' }, { logLevel: 'debug' }])
    await freshReceipt.postSettleRefetch
  })

  test('credential-only reset fences old receipts but drains the same-resource write before a fresh read', async () => {
    const oldWrite = deferred<Config>()
    const started: string[] = []
    let persisted = config('zh-CN')
    const coordinator = new ConfigReceiptCoordinator({
      read: async () => {
        started.push('read')
        return persisted
      },
      write: async () => {
        started.push('write')
        const next = await oldWrite.promise
        persisted = next
        return next
      },
    })

    const oldRequest = coordinator.write({ language: 'en-US' })
    await flushMicrotasks()
    coordinator.resetGeneration({ resourceChanged: false })
    const freshRead = coordinator.read()
    await flushMicrotasks()
    expect(started).toEqual(['write'])

    oldWrite.resolve(config('en-US'))
    await expect(oldRequest).rejects.toBeInstanceOf(ConfigReceiptGenerationError)
    await expect(freshRead).resolves.toMatchObject({
      generation: 2,
      config: config('en-US'),
    })
    expect(started).toEqual(['write', 'read'])
  })

  test('a response-loss barrier survives switching A -> B -> A', async () => {
    const started: ConfigPatch[] = []
    const coordinator = new ConfigReceiptCoordinator(
      {
        read: async () => config('en-US'),
        write: async (patch) => {
          started.push(patch)
          if (patch.language === 'en-US') throw new TypeError('response lost')
          return config('en-US')
        },
      },
      { initialResourceKey: 'daemon:A' },
    )

    await expect(coordinator.write({ language: 'en-US' })).rejects.toBeInstanceOf(
      ConfigAmbiguousWriteError,
    )

    coordinator.resetGeneration({ resourceChanged: true, resourceKey: 'daemon:B' })
    const daemonB = await coordinator.write({ theme: 'dark' })
    await daemonB.postSettleRefetch

    coordinator.resetGeneration({ resourceChanged: true, resourceKey: 'daemon:A' })
    expect(coordinator.getWriteBlock()).toBeInstanceOf(ConfigAmbiguousWriteError)
    await expect(coordinator.write({ logLevel: 'debug' })).rejects.toBeInstanceOf(
      ConfigWriteQueueBlockedError,
    )
    expect(started).toEqual([{ language: 'en-US' }, { theme: 'dark' }])
  })
})
