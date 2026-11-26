// RFC-602: a complete, cancelable cursor chain replaces the fixed 500-child
// window, and a failed refresh never publishes a partial absence snapshot.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TaskChildSummary, TaskChildrenPage } from '@agent-workflow/shared'
import { api } from '../src/api/client'
import { useTaskChildren, taskChildrenQueryKey } from '../src/hooks/useTaskChildren'
import { buildTaskSyncRules } from '../src/hooks/useTaskSync'
import { setBaseUrl } from '../src/stores/auth'

function child(id: string): TaskChildSummary {
  return { id, status: 'done' }
}
function page(
  parentTaskId: string,
  ids: string[],
  nextCursor: string | null = null,
): TaskChildrenPage {
  return { schemaVersion: 1, parentTaskId, items: ids.map(child), nextCursor }
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RFC-602 complete child pagination', () => {
  let client: QueryClient
  beforeEach(() => {
    setBaseUrl('http://children.test')
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  })
  afterEach(() => {
    cleanup()
    client.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  function useObserved(parent = 'p', enabled = true, parentActive = false) {
    const query = useTaskChildren(parent, enabled, parentActive)
    return { ...query, data: query.data, isFetching: query.isFetching, isError: query.isError }
  }

  test.each([0, 1, 100, 101, 500, 501, 1201])(
    'loads all %i rows with fixed page requests and no request after the tail',
    async (size) => {
      const ids = Array.from({ length: size }, (_, i) => `child-${i}`)
      const requests: URL[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = new URL(input.toString())
        requests.push(url)
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        return response(
          page(
            'p',
            ids.slice(offset, offset + 100),
            offset + 100 < size ? String(offset + 100) : null,
          ),
        )
      })
      const hook = renderHook(() => useObserved(), { wrapper })
      await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
      expect(hook.result.current.data?.map((item) => item.id)).toEqual(ids)
      expect(requests).toHaveLength(Math.max(1, Math.ceil(size / 100)))
      expect(
        requests.every(
          (url) =>
            url.pathname === '/api/tasks/p/children' && url.searchParams.get('limit') === '100',
        ),
      ).toBe(true)
      expect(new Set(hook.result.current.data?.map((item) => item.id)).size).toBe(size)
    },
  )

  test('two consumers share the entire chain and partial first pages are not published', async () => {
    const second = deferred<Response>()
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const cursor = new URL(input.toString()).searchParams.get('cursor')
      calls.push(cursor ?? 'first')
      return cursor === null ? response(page('p', ['a'], 'tail / 中文+?=')) : second.promise
    })
    const hook = renderHook(() => ({ first: useObserved(), second: useObserved() }), { wrapper })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual(['first', 'tail / 中文+?='])
    expect(hook.result.current.first.data).toBeUndefined()
    expect(hook.result.current.second.data).toBeUndefined()
    await act(async () => {
      second.resolve(response(page('p', ['b'])))
    })
    await waitFor(() => expect(hook.result.current.first.isSuccess).toBe(true))
    expect(hook.result.current.first.data).toEqual([child('a'), child('b')])
    expect(hook.result.current.second.data).toEqual(hook.result.current.first.data)
    expect(calls).toHaveLength(2)
  })

  test('overlapping live pages keep each child once and retain its latest returned status', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      if (calls === 1) return response(page('p', ['a', 'b'], 'tail'))
      return response({
        ...page('p', ['b', 'c']),
        items: [{ id: 'b', status: 'running' }, child('c')],
      })
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.data).toEqual([
      child('a'),
      { id: 'b', status: 'running' },
      child('c'),
    ])
    expect(calls).toBe(2)
  })

  test('a mid-chain refresh failure retains the last complete snapshot and an explicit retry rebuilds the chain', async () => {
    let refresh = false
    let fail = true
    const cursors: (string | null)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const cursor = new URL(input.toString()).searchParams.get('cursor')
      cursors.push(cursor)
      if (!refresh) return response(page('p', ['old']))
      if (cursor === null) return response(page('p', ['new-1'], 'next'))
      if (fail)
        return response(
          { ok: false, code: 'temporarily-unavailable', message: 'retry', details: null },
          503,
        )
      return response(page('p', ['new-2']))
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(hook.result.current.data).toEqual([child('old')]))
    refresh = true
    await act(async () => {
      await hook.result.current.refetch()
    })
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(hook.result.current.data).toEqual([child('old')])
    fail = false
    await act(async () => {
      await hook.result.current.refetch()
    })
    await waitFor(() => {
      expect(hook.result.current.isSuccess).toBe(true)
      expect(hook.result.current.data).toEqual([child('new-1'), child('new-2')])
    })
    expect(cursors).toEqual([null, null, 'next', null, 'next'])
  })

  test('a first-load tail failure publishes no partial snapshot and retry restarts at the first page', async () => {
    let fail = true
    const cursors: (string | null)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const cursor = new URL(input.toString()).searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor === null) return response(page('p', [fail ? 'discarded' : 'first'], 'tail'))
      return fail
        ? response({ ok: false, code: 'unavailable', message: 'retry', details: null }, 503)
        : response(page('p', ['last']))
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(hook.result.current.data).toBeUndefined()
    expect(client.getQueryData(taskChildrenQueryKey('p'))).toBeUndefined()
    fail = false
    await act(async () => {
      await hook.result.current.refetch()
    })
    await waitFor(() => {
      expect(hook.result.current.isSuccess).toBe(true)
      expect(hook.result.current.data).toEqual([child('first'), child('last')])
    })
    expect(cursors).toEqual([null, 'tail', null, 'tail'])
  })

  test('one consumer may unmount without canceling the shared chain, whose pages share the upstream signal', async () => {
    const tail = deferred<Response>()
    const requests = vi.spyOn(api, 'get')
    const signals: (AbortSignal | null | undefined)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      signals.push(init?.signal)
      return new URL(input.toString()).searchParams.has('cursor')
        ? tail.promise
        : response(page('p', ['first'], 'tail'))
    })
    const first = renderHook(() => useObserved(), { wrapper })
    const second = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBeInstanceOf(AbortSignal)
    // api.get adds an independent deadline to each HTTP request. The query's
    // cancellation signal is shared upstream, rather than the combined signals.
    expect(requests).toHaveBeenCalledTimes(2)
    const upstream = requests.mock.calls[0]?.[2]
    expect(upstream).toBeInstanceOf(AbortSignal)
    expect(requests.mock.calls[1]?.[2]).toBe(upstream)
    first.unmount()
    expect(upstream?.aborted).toBe(false)
    expect(signals.map((signal) => signal?.aborted)).toEqual([false, false])
    await act(async () => {
      tail.resolve(response(page('p', ['last'])))
    })
    await waitFor(() => expect(second.result.current.data).toEqual([child('first'), child('last')]))
    expect(signals).toHaveLength(2)
  })

  test('unmounting the last consumer cancels the in-flight tail without publishing partial rows', async () => {
    let tailSignal: AbortSignal | null | undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!new URL(input.toString()).searchParams.has('cursor'))
        return response(page('p', ['a'], 'tail'))
      tailSignal = init?.signal
      return new Promise<Response>((_resolve, reject) =>
        tailSignal?.addEventListener('abort', () => reject(tailSignal?.reason), { once: true }),
      )
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(hook.result.current.data).toBeUndefined()
    hook.unmount()
    expect(tailSignal?.aborted).toBe(true)
    expect(client.getQueryData(taskChildrenQueryKey('p'))).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('switching parents cancels the old chain and a late tail cannot overwrite the new parent', async () => {
    const tail = deferred<Response>()
    let tailSignal: AbortSignal | null | undefined
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.includes('/other/')) return response(page('other', ['other-child']))
      if (!url.searchParams.has('cursor')) return response(page('p', ['old-first'], 'tail'))
      tailSignal = init?.signal
      return tail.promise
    })
    const hook = renderHook(({ parent }) => useObserved(parent), {
      wrapper,
      initialProps: { parent: 'p' },
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    hook.rerender({ parent: 'other' })
    await waitFor(() => expect(hook.result.current.data).toEqual([child('other-child')]))
    expect(tailSignal?.aborted).toBe(true)
    await act(async () => {
      tail.resolve(response(page('p', ['old-tail'])))
    })
    expect(hook.result.current.data).toEqual([child('other-child')])
    expect(requests).toHaveLength(3)
  })

  test.each([
    'repeated cursor',
    'wrong parent',
    'bad schema',
    'oversized page',
    'unknown status',
  ] as const)('rejects %s without treating partial pages as complete', async (kind) => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      if (calls === 1) return response(page('p', ['a'], 'tail'))
      if (kind === 'wrong parent') return response(page('different', ['b']))
      if (kind === 'bad schema') return response({ ...page('p', ['b']), schemaVersion: 99 })
      if (kind === 'oversized page')
        return response(
          page(
            'p',
            Array.from({ length: 201 }, (_, i) => `large-${i}`),
          ),
        )
      if (kind === 'unknown status')
        return response({ ...page('p', []), items: [{ id: 'b', status: 'unrecognized' }] })
      return response(page('p', ['b'], 'tail'))
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(hook.result.current.data).toBeUndefined()
    expect(calls).toBe(2)
  })

  test('disabled performs no transport; encoded parent identities and invalidation preserve the shared key', async () => {
    const parent = 'parent / 中文+?='
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(new URL(input.toString()))
      return response(page(parent, []))
    })
    const hook = renderHook(({ enabled }) => useObserved(parent, enabled), {
      wrapper,
      initialProps: { enabled: false },
    })
    expect(requests).toEqual([])
    hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(requests[0]?.pathname).toBe(`/api/tasks/${encodeURIComponent(parent)}/children`)
    await act(async () => {
      await client.invalidateQueries({ queryKey: taskChildrenQueryKey(parent) })
    })
    expect(requests).toHaveLength(2)
  })

  test.each([
    ['active parent', true, 'done', true],
    ['active child', false, 'running', true],
    ['terminal parent and child', false, 'done', false],
  ] as const)(
    '%s controls the five-second fallback for the entire page chain',
    async (_name, parentActive, status, polls) => {
      vi.useFakeTimers()
      const cursors: (string | null)[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const cursor = new URL(input.toString()).searchParams.get('cursor')
        cursors.push(cursor)
        return response(
          cursor === null
            ? page('p', ['first'], 'tail')
            : { ...page('p', ['last']), items: [{ id: 'last', status }] },
        )
      })
      const hook = renderHook(() => useObserved('p', true, parentActive), { wrapper })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(cursors).toEqual([null, 'tail'])
      expect(hook.result.current.data).toEqual([child('first'), { id: 'last', status }])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999)
      })
      expect(cursors).toHaveLength(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(cursors).toEqual(polls ? [null, 'tail', null, 'tail'] : [null, 'tail'])
    },
  )

  test('an active parent polls an initially empty list and stops after the parent settles', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      return response(page('p', []))
    })
    const hook = renderHook(({ active }) => useObserved('p', true, active), {
      wrapper,
      initialProps: { active: true },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.data).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(calls).toBe(2)
    hook.rerender({ active: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(calls).toBe(2)
  })

  test('the production node-status invalidation rule rebuilds every page for an idle parent', async () => {
    let refresh = false
    const cursors: (string | null)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const cursor = new URL(input.toString()).searchParams.get('cursor')
      cursors.push(cursor)
      if (!refresh) return response(page('p', []))
      return response(cursor === null ? page('p', ['first'], 'tail') : page('p', ['last']))
    })
    const hook = renderHook(() => useObserved(), { wrapper })
    await waitFor(() => expect(hook.result.current.data).toEqual([]))
    const rules = buildTaskSyncRules('p')
    const keys = rules['node.status']!(
      { id: 1, type: 'node.status', nodeId: 'call', nodeRunId: 'run', status: 'running' },
      undefined,
    )
    expect(keys).toContainEqual(taskChildrenQueryKey('p'))
    refresh = true
    await act(async () => {
      await Promise.all((keys ?? []).map((queryKey) => client.invalidateQueries({ queryKey })))
    })
    await waitFor(() => {
      expect(hook.result.current.isSuccess).toBe(true)
      expect(hook.result.current.data).toEqual([child('first'), child('last')])
    })
    expect(cursors).toEqual([null, null, 'tail'])
  })
})
