// The existing split-page, pagination and virtual-list suites cover presentation.
// These contracts exercise the shared collection hooks with a real QueryClient;
// only the transport/fetch-page effect is replaced by deterministic fixtures.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { usePagedList } from '../src/hooks/usePagedList'
import { useResourceList } from '../src/hooks/useResourceList'
import { getToken, setBaseUrl, setToken } from '../src/stores/auth'
import { seedFullAccessActor } from './unexpectedNetwork'

interface Page {
  items: string[]
  nextCursor: string | null
}

const clients: QueryClient[] = []

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
  clients.push(client)
  seedFullAccessActor(client, getToken() ?? 'tok')
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})

describe('module contract — shared collection hooks', () => {
  test('a disabled list makes no request; an empty terminal page never fetches a second page', async () => {
    const fetchPage = vi.fn(
      async (_cursor: string | null): Promise<Page> => ({ items: [], nextCursor: null }),
    )
    const { result, rerender } = renderHook(
      ({ enabled }) => usePagedList({ queryKey: ['contract-empty'], fetchPage, enabled }),
      { initialProps: { enabled: false }, wrapper: wrapper() },
    )
    expect(fetchPage).not.toHaveBeenCalled()
    expect(result.current.isFetching).toBe(false)
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.pages).toEqual([{ items: [], nextCursor: null }])
    expect(result.current.hasNextPage).toBe(false)
    await act(async () => {
      await result.current.fetchNextPage()
    })
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage.mock.calls[0]?.[0]).toBeNull()
  })

  test('a next-page failure keeps the displayed page and retries that same cursor once on request', async () => {
    const failure = new Error('fixture next page unavailable')
    let attempts = 0
    const cursors: Array<string | null> = []
    const fetchPage = vi.fn(async (cursor: string | null): Promise<Page> => {
      cursors.push(cursor)
      if (cursor === null) return { items: ['first'], nextCursor: 'after-first' }
      attempts += 1
      if (attempts === 1) throw failure
      return { items: ['second'], nextCursor: null }
    })
    const { result } = renderHook(() => usePagedList({ queryKey: ['contract-retry'], fetchPage }), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true))
    expect(result.current.error).toBe(failure)
    expect(result.current.data?.pages).toEqual([{ items: ['first'], nextCursor: 'after-first' }])
    expect(result.current.hasNextPage).toBe(true)
    expect(cursors).toEqual([null, 'after-first'])
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual(['first', 'second'])
    expect(result.current.hasNextPage).toBe(false)
    expect(cursors).toEqual([null, 'after-first', 'after-first'])
  })

  test('changing filters keeps previous rows while loading but starts the new list from its first cursor', async () => {
    const second = deferred<Page>()
    const calls: Array<{ filter: string; cursor: string | null }> = []
    const { result, rerender } = renderHook(
      ({ filter }) =>
        usePagedList({
          queryKey: ['contract-filter', filter],
          keepPreviousData: true,
          async fetchPage(cursor): Promise<Page> {
            calls.push({ filter, cursor })
            return filter === 'first'
              ? { items: ['previous row'], nextCursor: 'old-cursor' }
              : second.promise
          },
        }),
      { initialProps: { filter: 'first' }, wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    rerender({ filter: 'second' })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(result.current.isPlaceholderData).toBe(true)
    expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual(['previous row'])
    expect(calls[1]).toEqual({ filter: 'second', cursor: null })
    await act(async () => {
      second.resolve({ items: ['new row'], nextCursor: null })
      await second.promise
    })
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false))
    expect(result.current.data?.pages).toEqual([{ items: ['new row'], nextCursor: null }])
  })

  test('changing the key aborts an obsolete request and its late result cannot replace the selected filter', async () => {
    const stale = deferred<Page>()
    let staleSignal: AbortSignal | undefined
    const { result, rerender } = renderHook(
      ({ filter }) =>
        usePagedList({
          queryKey: ['contract-cancel', filter],
          async fetchPage(_cursor, signal): Promise<Page> {
            if (filter === 'old') {
              staleSignal = signal
              return stale.promise
            }
            return { items: ['selected'], nextCursor: null }
          },
        }),
      { initialProps: { filter: 'old' }, wrapper: wrapper() },
    )
    await waitFor(() => expect(staleSignal).toBeDefined())
    rerender({ filter: 'selected' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(staleSignal?.aborted).toBe(true)
    await act(async () => {
      stale.resolve({ items: ['obsolete'], nextCursor: null })
      await stale.promise
    })
    expect(result.current.data?.pages).toEqual([{ items: ['selected'], nextCursor: null }])
  })

  test('maxPages bounds retained pages while forward cursors remain correct', async () => {
    const cursors: Array<string | null> = []
    const { result } = renderHook(
      () => {
        const query = usePagedList({
          queryKey: ['contract-page-budget'],
          maxPages: 2,
          async fetchPage(cursor): Promise<Page> {
            cursors.push(cursor)
            if (cursor === null) return { items: ['one'], nextCursor: 'two' }
            if (cursor === 'two') return { items: ['two'], nextCursor: 'three' }
            return { items: ['three'], nextCursor: null }
          },
        })
        // Subscribe during render, as a list component does. Reading only
        // isSuccess outside render would not subscribe to later page changes.
        return {
          data: query.data,
          hasNextPage: query.hasNextPage,
          isSuccess: query.isSuccess,
          fetchNextPage: query.fetchNextPage,
        }
      },
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() =>
      expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual(['one', 'two']),
    )
    expect(cursors).toEqual([null, 'two'])
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual(['two', 'three'])
    expect(result.current.data?.pageParams).toEqual(['two', 'three'])
    expect(cursors).toEqual([null, 'two', 'three'])
  })

  test('a failed delete preserves the list without refetching; explicit retry deletes by encoded id and refreshes once', async () => {
    setBaseUrl('http://collections.test')
    setToken('contract-token')
    const row = { id: 'stable/id with space', name: 'Editable title' }
    let deleted = false
    let fail = true
    const calls: Array<{ method: string; url: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (method === 'GET' && url.endsWith('/api/agents'))
        return Response.json(deleted ? [] : [row])
      if (method === 'DELETE' && url.endsWith('/api/agents/stable%2Fid%20with%20space')) {
        if (fail) return Response.json({ error: 'fixture delete unavailable' }, { status: 503 })
        deleted = true
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected collection request: ${method} ${url}`)
    })
    const { result } = renderHook(
      () =>
        useResourceList<typeof row>({
          queryKey: ['contract-resource-list'],
          endpoint: '/api/agents',
        }),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.data).toEqual([row]))
    await act(async () => {
      await expect(result.current.del.mutateAsync(row)).rejects.toThrow()
    })
    expect(result.current.data).toEqual([row])
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE'])
    fail = false
    await act(async () => {
      await result.current.del.mutateAsync(row)
    })
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'DELETE', 'GET'])
    expect(result.current.del.error).toBeNull()
  })
})
