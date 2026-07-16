// RFC-201 PR-A integration checks for the browser-tab config singleton. The
// pure coordinator suite owns epoch/FIFO mechanics; these cases lock auth
// generation wiring and QueryClient cache publication at the real API adapter.

import { QueryClient } from '@tanstack/react-query'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cacheConfigWriteReceipt,
  configReceiptCoordinator,
  getConfigQueryKey,
  queryConfig,
  writeConfigPatch,
} from '@/lib/config-resource'
import { ConfigAmbiguousWriteError, ConfigWriteQueueBlockedError } from '@/lib/config-receipts'
import { clearToken, setBaseUrl, setToken } from '@/stores/auth'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jsonResponse(config: Config): Response {
  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let testBaseUrl: string

beforeEach(() => {
  testBaseUrl = `http://config-resource-${crypto.randomUUID()}.test`
  setBaseUrl(testBaseUrl)
  setToken('config-resource-token')
})

afterEach(() => {
  clearToken()
  setBaseUrl(`http://config-resource-cleanup-${crypto.randomUUID()}.test`)
  vi.restoreAllMocks()
})

describe('config-resource singleton', () => {
  test('auth generation changes only when the base-url/token identity changes', () => {
    const initial = configReceiptCoordinator.currentGeneration
    const initialQueryKey = getConfigQueryKey()
    setBaseUrl(testBaseUrl)
    expect(configReceiptCoordinator.currentGeneration).toBe(initial)

    setToken('next-token')
    expect(configReceiptCoordinator.currentGeneration).toBe(initial + 1)
    expect(getConfigQueryKey()).toEqual(initialQueryKey)
    setToken('next-token')
    expect(configReceiptCoordinator.currentGeneration).toBe(initial + 1)

    setBaseUrl('http://other-daemon.test')
    expect(configReceiptCoordinator.currentGeneration).toBe(initial + 2)
    expect(getConfigQueryKey()).not.toEqual(initialQueryKey)
  })

  test('a late post-write GET cannot overwrite the cache after a newer write', async () => {
    const configA: Config = { ...DEFAULT_CONFIG, language: 'en-US' }
    const configB: Config = { ...configA, theme: 'dark' }
    const readA = deferred<Response>()
    const readB = deferred<Response>()
    const pendingReads = [readA.promise, readB.promise]
    const putBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        putBodies.push(body)
        return jsonResponse(body.theme === 'dark' ? configB : configA)
      }
      const next = pendingReads.shift()
      if (next === undefined) throw new Error('unexpected config GET')
      return next
    })

    const client = new QueryClient()
    const queryKey = getConfigQueryKey()
    const receiptA = await writeConfigPatch({ language: 'en-US' })
    cacheConfigWriteReceipt(client, receiptA)
    expect(client.getQueryData(queryKey)).toEqual(configA)

    const receiptB = await writeConfigPatch({ theme: 'dark' })
    cacheConfigWriteReceipt(client, receiptB)
    expect(client.getQueryData(queryKey)).toEqual(configB)
    expect(putBodies).toEqual([{ language: 'en-US' }, { theme: 'dark' }])

    readA.resolve(jsonResponse(configA))
    await receiptA.postSettleRefetch
    await Promise.resolve()
    expect(client.getQueryData(queryKey)).toEqual(configB)

    readB.resolve(jsonResponse(configB))
    await receiptB.postSettleRefetch
    await Promise.resolve()
    expect(client.getQueryData(queryKey)).toEqual(configB)
  })

  test('malformed GET data is rejected without publishing a receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    await expect(queryConfig()).rejects.toBeDefined()
    expect(configReceiptCoordinator.getSnapshot()).toBeUndefined()
  })

  test('a malformed successful PUT body is outcome-unknown and blocks the next writer', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
      )

    await expect(writeConfigPatch({ language: 'en-US' })).rejects.toBeInstanceOf(
      ConfigAmbiguousWriteError,
    )
    await expect(writeConfigPatch({ theme: 'dark' })).rejects.toBeInstanceOf(
      ConfigWriteQueueBlockedError,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(configReceiptCoordinator.getSnapshot()).toBeUndefined()
  })

  test('malformed post-settle GET leaves the exact PUT receipt cached', async () => {
    const exact: Config = { ...DEFAULT_CONFIG, theme: 'dark' }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(exact))
      .mockResolvedValueOnce(
        new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    const client = new QueryClient()
    const queryKey = getConfigQueryKey()

    const receipt = await writeConfigPatch({ theme: 'dark' })
    cacheConfigWriteReceipt(client, receipt)
    await expect(receipt.postSettleRefetch).rejects.toBeDefined()
    expect(client.getQueryData(queryKey)).toEqual(exact)
    expect(configReceiptCoordinator.getSnapshot()).toBe(receipt)
  })
})
