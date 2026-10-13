// RFC-371 capacity is operational evidence, never a cap or a replacement for Token/CNY totals.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ObservationStorage } from '../src/components/observability/ObservationStorage'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'
let client: QueryClient | undefined
beforeEach(async () => {
  setBaseUrl('http://storage.test')
  setToken('storage-admin')
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  client?.clear()
  vi.restoreAllMocks()
})
const status = {
  sampledAt: 1791849600000,
  databaseBytes: '1048576',
  factsBytes: '524288',
  derivedBytes: '262144',
  indexBytes: '262144',
  reusableBytes: '0',
  freeBytes: null,
  growthBytesPerDay: null,
  daysRemaining: null,
  pending: '12001',
  oldestPendingAt: 1791849500000,
  activeReports: '201',
  retiringReports: '2',
  reclaimed: '10001',
  lastSuccess: 1791849600000,
  lastError: null,
  retentionDays: 7,
}
function mount(allowed: boolean) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['auth', 'me', 'storage-admin'], {
    user: { id: 'storage-admin', status: 'active' },
    permissions: allowed ? ['settings:write'] : [],
  })
  render(
    <QueryClientProvider client={client}>
      <ObservationStorage />
    </QueryClientProvider>,
  )
}
test('shows the full queue and actual capacity, marks remote free bytes unknown, uses standard details layout', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
    expect(new URL(String(raw)).pathname).toBe('/api/observability/storage')
    return Response.json(status)
  })
  mount(true)
  expect(await screen.findByText('12001 ·', { exact: false })).toBeTruthy()
  expect(screen.getByText('201 / 2')).toBeTruthy()
  expect(screen.getAllByText('未采集').length).toBeGreaterThan(1)
  expect(document.querySelector('dl.detail-grid')).toBeTruthy()
  expect(screen.queryByText(/美元|USD/)).toBeNull()
})
test('permission denial makes no storage request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  mount(false)
  await waitFor(() => expect(document.querySelector('dl')).toBeNull())
  expect(fetch).not.toHaveBeenCalled()
})
test('cleanup failure and capacity pressure are visible without replacing accepted metrics', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      ...status,
      freeBytes: '1048576',
      growthBytesPerDay: '524288',
      daysRemaining: 2,
      lastError: 'database full',
    }),
  )
  mount(true)
  expect(await screen.findByText(/database full/)).toBeTruthy()
  expect(screen.getByText(/不足 7 天/)).toBeTruthy()
  expect(screen.getByText('201 / 2')).toBeTruthy()
})

test('an expired retained identity rebuilds the original period before any new pagination', async () => {
  const { useCompleteObservationReport } =
    await import('../src/components/observability/completeReportClient')
  const { fireEvent } = await import('@testing-library/react')
  const filters = { from: 1791840000000, to: 1791843600000, timezone: 'UTC' },
    requests: unknown[] = []
  let posts = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const path = new URL(String(raw)).pathname
    if (path.endsWith('/projection-version')) return Response.json(null)
    if (path === '/api/observability/reports') {
      requests.push(JSON.parse(String(init?.body)).filters)
      posts++
      return Response.json(
        posts === 1
          ? { reportId: 'expired-active-view', state: 'building', phase: 'queued' }
          : { reportId: 'fresh-view', state: 'not-ready', gaps: ['original-gap'] },
      )
    }
    if (path.endsWith('/expired-active-view'))
      return Response.json({ error: 'not-found', message: 'expired' }, { status: 404 })
    throw Error('unexpected ' + path)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  function Probe() {
    const q = useCompleteObservationReport(filters, undefined, 0, true)
    return (
      <>
        <p>{q.data?.state === 'ready' ? q.data.header.reportId : q.data?.reportId}</p>
        <button onClick={() => void q.refetch()}>renew</button>
      </>
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  await screen.findByText('expired-active-view')
  fireEvent.click(screen.getByText('renew'))
  expect(await screen.findByText('fresh-view')).toBeTruthy()
  expect(requests).toEqual([filters, filters])
})
