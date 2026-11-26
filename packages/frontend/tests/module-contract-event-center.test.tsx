// Render the real Event Center route, Select, Pagination, API client and QueryClient.
// Only the global navigation shell and HTTP effects are fixtures. The polling clock
// is held still so request budgets describe explicit user operations, not wall time.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { seedFullAccessActor } from './unexpectedNetwork'

vi.mock('../src/routes/__root', async () => {
  const { createRootRoute, Outlet } = await import('@tanstack/react-router')
  return { Route: createRootRoute({ component: Outlet }) }
})

import { Route as RootRoute } from '../src/routes/__root'
import { Route as EventsRoute } from '../src/routes/events'

interface Delivery {
  eventId: string
  stage: 'producer-publication' | 'consumer-delivery'
  producer: 'task-execution'
  family: 'task-lifecycle'
  eventType: string
  aggregateKind: 'task'
  aggregateId: string
  aggregateSeq: number
  consumerId: string
  mode: 'dispatchable'
  state: 'pending' | 'dead-letter'
  attemptCount: number
  nextAttemptAt: string | null
  leaseEpoch: number
  lastErrorSummary: string | null
  updatedAt: string
  canRetry: boolean
}

interface Call {
  method: string
  url: URL
  body: unknown
}

const first: Delivery = {
  eventId: 'event/one',
  stage: 'consumer-delivery',
  producer: 'task-execution',
  family: 'task-lifecycle',
  eventType: 'task.completed',
  aggregateKind: 'task',
  aggregateId: 'task-one',
  aggregateSeq: 3,
  consumerId: 'consumer/one',
  mode: 'dispatchable',
  state: 'dead-letter',
  attemptCount: 3,
  nextAttemptAt: null,
  leaseEpoch: 8,
  lastErrorSummary: 'Consumer temporarily unavailable',
  updatedAt: '2026-11-01T00:00:00.123Z',
  canRetry: true,
}
const second: Delivery = {
  ...first,
  eventId: 'event-two',
  eventType: 'task.started',
  aggregateId: 'task-two',
  canRetry: false,
}
let client: QueryClient
let calls: Call[]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function page(items: Delivery[], current = 1, total = items.length, pageCount = 1) {
  return { items, total, page: current, pageCount }
}

function installHTTP(options: {
  committed: (url: URL) => Response | Promise<Response>
  retry?: (call: Call) => Response | Promise<Response>
  catalog?: () => Response | Promise<Response>
}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const call = {
      method,
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    }
    calls.push(call)
    if (method === 'POST' && url.pathname.endsWith('/retry') && options.retry !== undefined)
      return options.retry(call)
    if (method !== 'GET') throw new Error(`unexpected method ${method} ${url.pathname}`)
    switch (url.pathname) {
      case '/api/event-center/catalog':
        return options.catalog?.() ?? Response.json({ sources: [], eventTypes: [] })
      case '/api/event-center/sources':
      case '/api/event-center/observers':
        return Response.json({ items: [] })
      case '/api/event-center/subscriptions/page':
      case '/api/event-center/deliveries/page':
      case '/api/event-center/events/page':
        return Response.json({ items: [], total: 0, page: 1, pageCount: 1 })
      case '/api/event-center/committed-deliveries/page':
        return options.committed(url)
      default:
        throw new Error(`unexpected event-center request ${method} ${url.pathname}`)
    }
  })
}

function committedReads() {
  return calls.filter(
    (call) =>
      call.method === 'GET' && call.url.pathname === '/api/event-center/committed-deliveries/page',
  )
}
function retryCalls() {
  return calls.filter((call) => call.method === 'POST')
}
function rowId(delivery: Delivery) {
  return `committed-delivery-row-${delivery.eventId}-${delivery.consumerId}`
}
function retryButton() {
  return screen.getByTestId(
    `committed-delivery-retry-${first.eventId}-${first.consumerId}`,
  ) as HTMLButtonElement
}

function mount() {
  const router = createRouter({
    routeTree: RootRoute.addChildren([EventsRoute]),
    history: createMemoryHistory({ initialEntries: ['/events?tab=deliveries'] }),
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

async function pickOption(name: string, label: string) {
  fireEvent.click(screen.getByRole('combobox', { name }))
  const list = await screen.findByRole('listbox')
  const option = within(list)
    .getAllByRole('option')
    .find((item) => item.textContent?.startsWith(label))
  if (option === undefined) throw new Error(`missing option ${label}`)
  fireEvent.mouseDown(option)
}

async function platformDeliveries() {
  await screen.findByTestId('event-center-page')
  await pickOption('Choose event activity scope', 'Platform deliveries')
  await screen.findByTestId('committed-delivery-list')
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://event-contract-${crypto.randomUUID()}.test`)
  setToken('tok')
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  seedFullAccessActor(client)
  calls = []
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('module contract — Event Center platform deliveries', () => {
  test('loads the real operations page, expands error facts, and resets pagination when HTTP filters change', async () => {
    const catalog = deferred<Response>()
    installHTTP({
      catalog: () => catalog.promise,
      committed(url) {
        const current = Number(url.searchParams.get('page'))
        if (url.searchParams.has('aggregateId')) return Response.json(page([]))
        return Response.json(page([current === 1 ? first : second], current, 51, 2))
      },
    })
    mount()
    await screen.findByRole('status')
    expect(screen.queryByTestId('event-center-page')).toBeNull()
    await act(async () => {
      catalog.resolve(Response.json({ sources: [], eventTypes: [] }))
      await catalog.promise
    })
    await platformDeliveries()
    expect(screen.getByTestId(rowId(first))).toBeTruthy()
    expect(screen.getByText('51 platform deliveries')).toBeTruthy()
    expect(committedReads()).toHaveLength(1)
    expect(committedReads()[0]!.url.searchParams.get('limit')).toBe('50')
    fireEvent.click(
      screen.getByTestId(`committed-delivery-expand-${first.eventId}-${first.consumerId}`),
    )
    expect(screen.getByText(first.lastErrorSummary!)).toBeTruthy()
    expect(screen.getByText(first.eventId)).toBeTruthy()
    fireEvent.click(
      within(screen.getByTestId('committed-delivery-pagination')).getByRole('button', {
        name: 'Next',
      }),
    )
    await screen.findByTestId(rowId(second))
    expect(committedReads().at(-1)!.url.searchParams.get('page')).toBe('2')
    expect(screen.queryByText(first.lastErrorSummary!)).toBeNull()
    await pickOption('Filter by stage', 'Consumer delivery')
    await waitFor(() =>
      expect(committedReads().at(-1)!.url.searchParams.get('stage')).toBe('consumer-delivery'),
    )
    expect(committedReads().at(-1)!.url.searchParams.get('page')).toBe('1')
    await screen.findByTestId(rowId(first))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by aggregate ID' }), {
      target: { value: '  task/missing  ' },
    })
    await screen.findByText('No platform deliveries match these filters.')
    expect(committedReads().at(-1)!.url.searchParams.get('aggregateId')).toBe('task/missing')
    expect(committedReads().at(-1)!.url.searchParams.get('stage')).toBe('consumer-delivery')
    expect(committedReads().at(-1)!.url.searchParams.get('page')).toBe('1')
    expect(committedReads()).toHaveLength(4)
    expect(screen.queryByTestId('committed-delivery-pagination')).toBeNull()
  })

  test('retry posts the displayed observation, suppresses repeat clicks while pending and refreshes only committed deliveries', async () => {
    const receipt = deferred<Response>()
    let saved = false
    installHTTP({
      committed: () =>
        Response.json(
          page([
            {
              ...first,
              ...(saved
                ? { state: 'pending', canRetry: false, attemptCount: 0, lastErrorSummary: null }
                : {}),
            },
          ]),
        ),
      retry: () => receipt.promise,
    })
    mount()
    await platformDeliveries()
    const initialRequests = calls.length
    fireEvent.click(retryButton())
    await waitFor(() => expect(retryButton().disabled).toBe(true))
    expect(retryButton().textContent).toBe('Retrying…')
    fireEvent.click(retryButton())
    expect(retryCalls()).toHaveLength(1)
    expect(retryCalls()[0]!.url.pathname).toBe(
      '/api/event-center/committed-deliveries/event%2Fone/consumer%2Fone/retry',
    )
    expect(retryCalls()[0]!.body).toEqual({
      observedLeaseEpoch: 8,
      observedUpdatedAt: Date.parse(first.updatedAt),
    })
    saved = true
    await act(async () => {
      receipt.resolve(Response.json({ ok: true }))
      await receipt.promise
    })
    await waitFor(() =>
      expect(
        screen.queryByTestId(`committed-delivery-retry-${first.eventId}-${first.consumerId}`),
      ).toBeNull(),
    )
    expect(within(screen.getByTestId(rowId(first))).getByText('Pending')).toBeTruthy()
    expect(committedReads()).toHaveLength(2)
    expect(
      calls.slice(initialRequests).map((call) => `${call.method} ${call.url.pathname}`),
    ).toEqual([
      'POST /api/event-center/committed-deliveries/event%2Fone/consumer%2Fone/retry',
      'GET /api/event-center/committed-deliveries/page',
    ])
  })

  test('retry failure retains the row and shows an error; an explicit second retry succeeds without an automatic duplicate', async () => {
    let failed = false
    let saved = false
    installHTTP({
      committed: () =>
        Response.json(
          page([{ ...first, ...(saved ? { state: 'pending', canRetry: false } : {}) }]),
        ),
      retry() {
        if (!failed) {
          failed = true
          return Response.json(
            {
              ok: false,
              code: 'event-center-retry-unavailable',
              message: 'Retry service temporarily unavailable',
            },
            { status: 503 },
          )
        }
        saved = true
        return Response.json({ ok: true })
      },
    })
    mount()
    await platformDeliveries()
    fireEvent.click(retryButton())
    await screen.findByRole('alert')
    expect(screen.getByTestId(rowId(first))).toBeTruthy()
    expect(retryButton().disabled).toBe(false)
    expect(retryCalls()).toHaveLength(1)
    expect(committedReads()).toHaveLength(1)
    fireEvent.click(retryButton())
    await waitFor(() =>
      expect(
        screen.queryByTestId(`committed-delivery-retry-${first.eventId}-${first.consumerId}`),
      ).toBeNull(),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(screen.getByTestId(rowId(first))).getByText('Pending')).toBeTruthy()
    expect(retryCalls()).toHaveLength(2)
    expect(committedReads()).toHaveLength(2)
  })
})
