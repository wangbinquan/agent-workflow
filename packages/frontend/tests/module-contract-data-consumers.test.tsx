// Module contracts exercised through the real hooks and HTTP serializer. Only
// the network boundary is replaced; query keys, shared DTO parsing, pagination,
// cancellation, and cache recovery remain production behavior.
import type {
  TaskCatalogListItem,
  TaskCatalogPage,
  TaskOperationsFilters,
} from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useTaskOperationsPage } from '../src/hooks/useTaskOperationsPage'
import { taskChildrenQueryKey, useTaskChildren } from '../src/hooks/useTaskChildren'
import { setBaseUrl } from '../src/stores/auth'

const filters: TaskOperationsFilters = {
  view: 'all',
  statuses: [],
  subject: 'all',
  scope: 'all',
  origin: 'all',
}

function item(id: string): TaskCatalogListItem {
  return {
    id,
    sourceId: 'workflow',
    title: id,
    subject: { resourceId: 'workflow-1', label: { 'zh-CN': '流程', 'en-US': 'Workflow' } },
    targetLabel: null,
    status: 'done',
    statusDetail: null,
    startedAt: 100,
    updatedAt: 200,
    finishedAt: 200,
    executionClock: { runningMs: 100, runningSince: null },
    ownerUserId: null,
    owner: null,
    ownerLabel: null,
    errorSummary: null,
    failureCode: null,
    childCount: 0,
    repositoryCount: 1,
    scheduledTaskId: null,
    openAlertCount: 0,
    hierarchy: {
      parentItemId: null,
      invocationDepth: 0,
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 0,
      matchingDescendantCount: 0,
      branchStartedAt: 100,
    },
  }
}

function page(ids: string[], nextCursor: string | null = null): TaskCatalogPage {
  return {
    schemaVersion: 1,
    sourceIds: ['workflow'],
    items: ids.map(item),
    nextCursor,
    facets: { all: 51, active: 0, attention: 0, finished: 51 },
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('module contract: frontend data consumers', () => {
  let client: QueryClient
  beforeEach(() => {
    setBaseUrl('http://module-contract.test')
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  })
  afterEach(() => {
    cleanup()
    client.clear()
    vi.restoreAllMocks()
  })
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }

  test('catalog serializes filters and opaque cursors exactly and stops at the terminal page', async () => {
    const cursor = 'snapshot:中文/+?=& 2'
    const firstIds = Array.from({ length: 50 }, (_, index) => `task-${index}`)
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input.toString())
      requests.push(url)
      return response(url.searchParams.has('cursor') ? page(['task-50']) : page(firstIds, cursor))
    })
    const selection = {
      ...filters,
      q: '流程 + review & verify',
      statuses: ['failed', 'done'] as TaskOperationsFilters['statuses'],
      origin: 'event' as const,
    }
    const { result } = renderHook(
      () => {
        const query = useTaskOperationsPage(selection, 'parent/+ 1', true, 'workflow')
        // React Query tracks fields consumed during rendering. Model the page
        // reading both its rows and the next-page control, so a successful page
        // append notifies this consumer even though isSuccess remains true.
        return {
          data: query.data,
          isSuccess: query.isSuccess,
          hasNextPage: query.hasNextPage,
          fetchNextPage: query.fetchNextPage,
        }
      },
      { wrapper },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      type: 'workflow',
      view: 'all',
      q: selection.q,
      statuses: 'failed,done',
      scope: 'all',
      origin: 'event',
      parent_id: 'parent/+ 1',
      limit: '50',
    })
    expect(requests[0]!.pathname).toBe('/api/task-catalog')
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    expect(requests[1]!.searchParams.get('cursor')).toBe(cursor)
    expect(result.current.data?.pages.flatMap((entry) => entry.items.map((row) => row.id))).toEqual(
      [...firstIds, 'task-50'],
    )
    expect(result.current.data?.pageParams).toEqual([null, cursor])
    await act(async () => {
      await result.current.fetchNextPage()
    })
    expect(requests).toHaveLength(2)
  })

  test('a malformed next page preserves loaded rows and retry resumes the same cursor', async () => {
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(new URL(input.toString()))
      if (requests.length === 1) return response(page(['saved-row'], 'next-1'))
      if (requests.length === 2) return response({ ...page(['broken-row']), schemaVersion: 2 })
      return response(page(['recovered-row']))
    })
    const { result } = renderHook(() => useTaskOperationsPage(filters), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true))
    expect(result.current.data?.pages).toEqual([page(['saved-row'], 'next-1')])
    expect(result.current.error?.name).toBe('ZodError')
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.pages.flatMap((entry) => entry.items.map((row) => row.id))).toEqual(
      ['saved-row', 'recovered-row'],
    )
    expect(requests.map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'next-1',
      'next-1',
    ])
  })

  test('a backend failure retains its code and details and an explicit retry replaces the error', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            ok: false,
            code: 'catalog-source-unavailable',
            message: 'source temporarily unavailable',
            details: { sourceId: 'digital-employee' },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        response({
          ...page(['recovered']),
          sourceIds: ['digital-employee'],
          items: [{ ...item('recovered'), sourceId: 'digital-employee' }],
        }),
      )
    const { result } = renderHook(
      () => useTaskOperationsPage(filters, undefined, true, 'digital-employee'),
      { wrapper },
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toMatchObject({
      status: 503,
      code: 'catalog-source-unavailable',
      details: { sourceId: 'digital-employee' },
    })
    expect(result.current.data).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.error).toBeNull()
    expect(result.current.data?.pages[0]?.items[0]).toMatchObject({
      id: 'recovered',
      sourceId: 'digital-employee',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('disabled catalog consumers send no request; equivalent consumers share one request and source changes isolate caches', async () => {
    let completeFirstRequest!: () => void
    const pendingFirstRequest = new Promise<void>((resolve) => {
      completeFirstRequest = resolve
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const source = new URL(input.toString()).searchParams.get('type')
      if (source === 'workflow') await pendingFirstRequest
      return response(page([source ?? 'all']))
    })
    const first = renderHook(
      ({ enabled }) => useTaskOperationsPage(filters, undefined, enabled, 'workflow'),
      { wrapper, initialProps: { enabled: false } },
    )
    expect(first.result.current.fetchStatus).toBe('idle')
    expect(fetch).not.toHaveBeenCalled()
    first.rerender({ enabled: true })
    const second = renderHook(
      () => useTaskOperationsPage({ ...filters }, undefined, true, 'workflow'),
      { wrapper },
    )
    expect(first.result.current.fetchStatus).toBe('fetching')
    expect(second.result.current.fetchStatus).toBe('fetching')
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      completeFirstRequest()
    })
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true))
    expect(first.result.current.data).toEqual(second.result.current.data)
    expect(fetch).toHaveBeenCalledTimes(1)
    const other = renderHook(() => useTaskOperationsPage(filters, undefined, true, 'agent'), {
      wrapper,
    })
    await waitFor(() => expect(other.result.current.isSuccess).toBe(true))
    expect(other.result.current.data?.pages[0]?.items[0]?.id).toBe('agent')
    expect(first.result.current.data?.pages[0]?.items[0]?.id).toBe('workflow')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('unmounting the last catalog consumer aborts its pending transport without retries', async () => {
    let signal: AbortSignal | null | undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })
    const hook = renderHook(() => useTaskOperationsPage(filters), { wrapper })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(false)
    hook.unmount()
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('list and detail child consumers share a parent request and its invalidation while other parents remain independent', async () => {
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input.toString())
      requests.push(url)
      return response({
        schemaVersion: 1,
        parentTaskId: url.pathname.split('/')[3],
        items: [],
        nextCursor: null,
      })
    })
    const consumers = renderHook(
      () => ({
        list: useTaskChildren('parent-1'),
        detail: useTaskChildren('parent-1'),
        other: useTaskChildren('parent-2'),
      }),
      { wrapper },
    )
    await waitFor(() =>
      expect(
        consumers.result.current.list.isSuccess &&
          consumers.result.current.detail.isSuccess &&
          consumers.result.current.other.isSuccess,
      ).toBe(true),
    )
    expect(requests).toHaveLength(2)
    expect(requests.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { limit: '100' },
      { limit: '100' },
    ])
    expect(requests.map((url) => url.pathname)).toEqual([
      '/api/tasks/parent-1/children',
      '/api/tasks/parent-2/children',
    ])
    await act(async () => {
      await client.invalidateQueries({ queryKey: taskChildrenQueryKey('parent-1') })
    })
    expect(requests.map((url) => url.pathname.split('/')[3])).toEqual([
      'parent-1',
      'parent-2',
      'parent-1',
    ])
    expect(consumers.result.current.list.data).toEqual([])
    expect(consumers.result.current.detail.data).toEqual([])
  })
})
